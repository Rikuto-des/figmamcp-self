// In-process render service used by both the legacy HTTP route and the MCP tools.
// All Supabase queries explicitly filter by created_by = userId to keep per-user
// isolation when called from authenticated MCP sessions.

import type {
  Classification,
  ImageFormat,
  RenderScale,
} from '@figma-mcp-poc/shared';
import { computeCacheKey } from '../cache.js';
import { getFileMeta, FigmaApiError } from '../figma-rest.js';
import { log } from '../logger.js';
import { renderNode, RenderError } from '../render.js';
import {
  appendAuditLog,
  downloadAsset,
  findCachedAsset,
  findLatestAsset,
  insertAsset,
  uploadAsset,
} from '../supabase.js';
import { normalizeNodeId, parseFigmaUrl } from '../url-parser.js';

/**
 * Internal-only result from renderForUser. Carries the raw bytes so callers
 * (MCP tool, debug endpoint) never need to mint a signed URL — they read
 * bytes directly. No transient public URL is ever created for the image.
 */
export interface RenderResult {
  asset_id: string;
  file_key: string;
  node_id: string;
  width: number;
  height: number;
  format: ImageFormat;
  scale: RenderScale;
  classification: Classification;
  tier: 'A' | 'B' | 'C';
  cache_hit: boolean;
  rendered_via: 'cache' | 'playwright';
  bytes: Buffer;
  mime_type: string;
}

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

export async function renderForUser(input: RenderForUserInput): Promise<RenderResult> {
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
  // Bytes are streamed directly from Supabase Storage using service_role auth —
  // NO signed URL is ever minted. Governance invariant: there is no public-bearer
  // artifact for the image at any point.
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
        bytesPath: 'service_role direct download (no signed URL minted)',
      });
      const bytes = await downloadAsset(latest.storage_path);
      log.info('render.bytes_loaded', { source: 'storage.download', bytes: bytes.length, signedUrlCreated: false });
      await appendAuditLog({
        userId,
        event: 'render.cache_hit',
        assetId: latest.id,
        meta: { fileKey, nodeId, durationMs: Date.now() - t0, source: 'fast_path' },
      });
      log.info('render.complete', { userId, fileKey, nodeId, cacheHit: true, durationMs: Date.now() - t0 });
      return {
        asset_id: latest.id,
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
        bytes,
        mime_type: latest.mime_type ?? (format === 'jpg' ? 'image/jpeg' : 'image/png'),
      };
    }
    log.info('render.cache_miss', { userId, fileKey, nodeId });
  }

  try {
    log.info('render.figma_rest_call', { fileKey, purpose: 'get file version for cache key' });
    // The Figma REST PAT may not have access to every file the logged-in browser
    // session can see (team/SSO scoping). Playwright still works via cookies, so
    // we fall back to a date-based cache key instead of failing the whole render.
    let fileVersion: string;
    try {
      // Hard 10 s cap: if Figma REST is slow/hanging/rate-limited, give up and
      // fall back to a date-based cache key. Playwright (cookies) still works.
      const meta = await Promise.race([
        getFileMeta(fileKey),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('figma_rest_timeout')), 10_000),
        ),
      ]);
      fileVersion = meta.lastModified;
    } catch (e) {
      const isPatScopeErr = e instanceof FigmaApiError && e.code === 'figma_node_not_found';
      const isUnauthorizedErr = e instanceof FigmaApiError && e.code === 'unauthorized';
      const isTimeoutErr = e instanceof Error && e.message === 'figma_rest_timeout';
      const isRateLimitErr =
        e instanceof FigmaApiError && e.code === 'internal_error' && /rate/i.test(e.message);
      if (isPatScopeErr || isUnauthorizedErr || isTimeoutErr || isRateLimitErr) {
        fileVersion = `no-rest-${new Date().toISOString().slice(0, 10)}`;
        log.warn('render.figma_rest_unavailable_fallback', {
          fileKey,
          fallback: fileVersion,
          reason: isPatScopeErr
            ? 'PAT 範囲外'
            : isUnauthorizedErr
              ? 'REST 403 (PAT 未設定 or 権限なし)'
              : isTimeoutErr
                ? 'REST 10s タイムアウト'
                : 'REST レート制限',
        });
      } else {
        throw e;
      }
    }

    const cacheKey = computeCacheKey({
      fileKey,
      nodeId,
      format,
      scale,
      fileVersion,
    });

    if (!input.forceRefresh) {
      const cached = await findCachedAsset({ cacheKey, userId });
      if (cached) {
        const bytes = await downloadAsset(cached.storage_path);
        log.info('render.bytes_loaded', { source: 'storage.download', bytes: bytes.length, signedUrlCreated: false });
        await appendAuditLog({
          userId,
          event: 'render.cache_hit',
          assetId: cached.id,
          meta: { fileKey, nodeId, durationMs: Date.now() - t0 },
        });
        return {
          asset_id: cached.id,
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
          bytes,
          mime_type: cached.mime_type ?? (cached.format === 'jpg' ? 'image/jpeg' : 'image/png'),
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
      fileVersion,
      classification,
      sizeBytes: rendered.bytes.length,
    });

    // No signed URL minted. Bytes are already in memory from Playwright (the
    // upload was a separate copy). Governance invariant: no transient public
    // URL exists for these bytes — they only ever lived in the service process.
    log.info('render.bytes_loaded', { source: 'playwright.inline', bytes: rendered.bytes.length, signedUrlCreated: false });

    await appendAuditLog({
      userId,
      event: 'render.completed',
      assetId: asset.id,
      meta: { fileKey, nodeId, durationMs: Date.now() - t0 },
    });

    return {
      asset_id: asset.id,
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
      bytes: rendered.bytes,
      mime_type: rendered.mimeType,
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
