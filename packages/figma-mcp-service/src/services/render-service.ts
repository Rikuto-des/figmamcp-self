// In-process render service used by both the legacy HTTP route and the MCP tools.
// All Supabase queries explicitly filter by created_by = userId to keep per-user
// isolation when called from authenticated MCP sessions.

import type {
  Classification,
  ImageFormat,
  RenderResponse,
  RenderScale,
} from '@figma-mcp-poc/shared';
import { computeCacheKey } from '../cache.js';
import { getFileMeta, FigmaApiError } from '../figma-rest.js';
import { log } from '../logger.js';
import { renderNode, RenderError } from '../render.js';
import {
  appendAuditLog,
  createSignedUrl,
  findCachedAsset,
  findLatestAsset,
  insertAsset,
  uploadAsset,
} from '../supabase.js';
import { normalizeNodeId, parseFigmaUrl } from '../url-parser.js';

export interface RenderForUserInput {
  userId: string;
  figmaUrl?: string;
  fileKey?: string;
  nodeId?: string;
  format?: ImageFormat;
  scale?: RenderScale;
  forceRefresh?: boolean;
  classification?: Classification;
}

export class RenderForUserError extends Error {
  constructor(public code: string, public httpStatus: number, message: string) {
    super(message);
    this.name = 'RenderForUserError';
  }
}

function resolveTarget(input: RenderForUserInput): { fileKey: string; nodeId: string } {
  if (input.figmaUrl) {
    const target = parseFigmaUrl(input.figmaUrl);
    if (!target) {
      throw new RenderForUserError('invalid_request', 400, 'failed to parse figma_url');
    }
    if (!target.nodeId) {
      throw new RenderForUserError('invalid_request', 400, 'node-id missing in URL');
    }
    return { fileKey: target.fileKey, nodeId: target.nodeId };
  }
  if (!input.fileKey || !input.nodeId) {
    throw new RenderForUserError(
      'invalid_request',
      400,
      'figma_url or (file_key + node_id) required',
    );
  }
  return { fileKey: input.fileKey, nodeId: normalizeNodeId(input.nodeId) };
}

export async function renderForUser(input: RenderForUserInput): Promise<RenderResponse> {
  const t0 = Date.now();
  const { fileKey, nodeId } = resolveTarget(input);
  const format: ImageFormat = input.format ?? 'png';
  const scale: RenderScale = input.scale ?? 2;
  const classification: Classification = input.classification ?? 'internal';
  const userId = input.userId;

  log.info('render.start', { userId, fileKey, nodeId, scale, format, forceRefresh: input.forceRefresh ?? false });

  await appendAuditLog({
    userId,
    event: 'render.requested',
    meta: { fileKey, nodeId, scale, format },
  });

  // Fast path: serve the most recent cached render without calling Figma REST.
  // This avoids rate-limit (429) errors when the same node is re-requested quickly.
  // TTL is 30 s — just long enough for the MCP tool to fetch bytes internally.
  // The signed URL is NEVER returned to the client; only bytes (base64) are.
  if (!input.forceRefresh) {
    log.info('render.cache_lookup', { userId, fileKey, nodeId, type: 'fast_path' });
    const latest = await findLatestAsset({ fileKey, nodeId, format, scale, userId });
    if (latest) {
      log.info('render.cache_hit', {
        userId,
        fileKey,
        nodeId,
        assetId: latest.id,
        storagePath: latest.storage_path,
        source: 'fast_path (no Figma REST call)',
        signedUrlTtlSec: 30,
        signedUrlExposedToClient: false,
      });
      const signed = await createSignedUrl(latest.storage_path, 30);
      log.info('render.signed_url_created', {
        ttlSec: 30,
        purpose: 'internal fetch only — expires before client could use it',
        exposedToClient: false,
      });
      await appendAuditLog({
        userId,
        event: 'render.cache_hit',
        assetId: latest.id,
        meta: { fileKey, nodeId, durationMs: Date.now() - t0, source: 'fast_path' },
      });
      log.info('render.complete', { userId, fileKey, nodeId, cacheHit: true, durationMs: Date.now() - t0 });
      return {
        asset_id: latest.id,
        signed_url: signed.url,
        signed_url_expires_at: signed.expiresAt,
        cache_hit: true,
        rendered_via: 'cache',
        width: latest.width ?? 0,
        height: latest.height ?? 0,
        format: latest.format,
        scale: latest.scale as RenderScale,
        classification: latest.classification,
        tier: latest.tier,
        file_key: latest.file_key,
        node_id: latest.node_id,
      };
    }
    log.info('render.cache_miss', { userId, fileKey, nodeId });
  }

  try {
    log.info('render.figma_rest_call', { fileKey, purpose: 'get file version for cache key' });
    const meta = await getFileMeta(fileKey);

    const cacheKey = computeCacheKey({
      fileKey,
      nodeId,
      format,
      scale,
      fileVersion: meta.lastModified,
    });

    if (!input.forceRefresh) {
      const cached = await findCachedAsset({ cacheKey, userId });
      if (cached) {
        const signed = await createSignedUrl(cached.storage_path, 30);
        await appendAuditLog({
          userId,
          event: 'render.cache_hit',
          assetId: cached.id,
          meta: { fileKey, nodeId, durationMs: Date.now() - t0 },
        });
        await appendAuditLog({
          userId,
          event: 'asset.download_url_issued',
          assetId: cached.id,
          meta: { ttlSec: 300 },
        });
        return {
          asset_id: cached.id,
          signed_url: signed.url,
          signed_url_expires_at: signed.expiresAt,
          cache_hit: true,
          rendered_via: 'cache',
          width: cached.width ?? 0,
          height: cached.height ?? 0,
          format: cached.format,
          scale: cached.scale as RenderScale,
          classification: cached.classification,
          tier: cached.tier,
          file_key: cached.file_key,
          node_id: cached.node_id,
        };
      }
    }

    log.info('render.playwright_start', { fileKey, nodeId, scale });
    const rendered = await renderNode({ fileKey, nodeId, scale });
    log.info('render.playwright_done', { fileKey, nodeId, width: rendered.width, height: rendered.height, bytes: rendered.bytes.length });

    log.info('render.storage_upload', { userId, fileKey, nodeId, mimeType: rendered.mimeType });
    const nodeIdSafe = nodeId.replace(/:/g, '_');
    const { path } = await uploadAsset({
      userId,
      fileKey,
      nodeIdSafe,
      bytes: rendered.bytes,
      mimeType: rendered.mimeType,
    });
    log.info('render.storage_upload_done', { storagePath: path });

    const asset = await insertAsset({
      userId,
      fileKey,
      nodeId,
      cacheKey,
      storagePath: path,
      mimeType: rendered.mimeType,
      width: rendered.width,
      height: rendered.height,
      scale,
      format,
      fileVersion: meta.lastModified,
      classification,
      sizeBytes: rendered.bytes.length,
    });

    // TTL 30 s: only used for the immediate internal fetch; never exposed to clients.
    const signed = await createSignedUrl(path, 30);
    log.info('render.signed_url_created', {
      ttlSec: 30,
      purpose: 'internal fetch only — expires before client could use it',
      exposedToClient: false,
    });

    await appendAuditLog({
      userId,
      event: 'render.completed',
      assetId: asset.id,
      meta: { fileKey, nodeId, durationMs: Date.now() - t0 },
    });
    await appendAuditLog({
      userId,
      event: 'asset.download_url_issued',
      assetId: asset.id,
      meta: { ttlSec: 300 },
    });

    return {
      asset_id: asset.id,
      signed_url: signed.url,
      signed_url_expires_at: signed.expiresAt,
      cache_hit: false,
      rendered_via: 'playwright',
      width: rendered.width,
      height: rendered.height,
      format,
      scale,
      classification,
      tier: 'B',
      file_key: fileKey,
      node_id: nodeId,
    };
  } catch (err) {
    if (err instanceof FigmaApiError) {
      const map = { figma_node_not_found: 404, unauthorized: 401, internal_error: 500 } as const;
      log.warn('render.failed', { code: err.code, fileKey, nodeId });
      void appendAuditLog({ userId, event: 'render.failed', meta: { code: err.code, fileKey, nodeId } });
      throw new RenderForUserError(err.code, map[err.code], err.message);
    }
    if (err instanceof RenderError) {
      const map: Record<RenderError['code'], number> = {
        figma_unauthenticated: 422,
        playwright_timeout: 504,
        figma_node_not_found: 404,
        figma_render_failed: 422,
        internal_error: 500,
      };
      log.warn('render.failed', { code: err.code, fileKey, nodeId });
      void appendAuditLog({ userId, event: 'render.failed', meta: { code: err.code, fileKey, nodeId } });
      throw new RenderForUserError(err.code, map[err.code], err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error('render.unhandled', { msg, fileKey, nodeId });
    void appendAuditLog({ userId, event: 'render.failed', meta: { msg, fileKey, nodeId } });
    throw new RenderForUserError('internal_error', 500, msg);
  }
}
