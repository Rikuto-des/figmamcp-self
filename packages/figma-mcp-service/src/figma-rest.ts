import { env } from './env.js';
import type { FigmaNode } from '@figma-mcp-poc/shared';

const FIGMA_API_BASE = 'https://api.figma.com';

interface FigmaFileMeta {
  name: string;
  lastModified: string;
  version: string;
  thumbnailUrl?: string;
}

export interface FigmaFileMetaResult {
  lastModified: string;
  version: string;
  name: string;
}

// In-memory cache for file metadata to avoid hitting Figma REST API rate limits.
// TTL: 5 minutes — Figma free tier rate limit is ~30 req/min; caching for 5 min
// means one REST call per file per 5 minutes at most.
const FILE_META_CACHE_TTL_MS = 5 * 60_000;
const fileMetaCache = new Map<string, { result: FigmaFileMetaResult; expiresAt: number }>();

/** Fetch with exponential backoff on 429 rate-limit responses. */
async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;

    lastRes = res;
    if (attempt < maxRetries) {
      // Honour Retry-After header if present, else exponential backoff: 2s, 4s, 8s
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt + 1) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return lastRes!;
}

export async function getFileMeta(fileKey: string): Promise<FigmaFileMetaResult> {
  const cached = fileMetaCache.get(fileKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const res = await fetchWithRetry(
    `${FIGMA_API_BASE}/v1/files/${fileKey}?depth=1`,
    { headers: { 'X-Figma-Token': env().FIGMA_TOKEN } },
  );
  if (res.status === 404) throw new FigmaApiError('figma_node_not_found', `file ${fileKey} not found`);
  if (res.status === 403 || res.status === 401)
    throw new FigmaApiError('unauthorized', `Figma REST auth failed: ${res.status}`);
  if (res.status === 429)
    throw new FigmaApiError('internal_error', `Figma REST rate limited after retries`);
  if (!res.ok) throw new FigmaApiError('internal_error', `Figma REST error: ${res.status}`);

  const json = (await res.json()) as FigmaFileMeta;
  const result: FigmaFileMetaResult = {
    lastModified: json.lastModified,
    version: json.version,
    name: json.name,
  };

  fileMetaCache.set(fileKey, { result, expiresAt: Date.now() + FILE_META_CACHE_TTL_MS });
  return result;
}

interface FigmaNodesResponse {
  nodes: Record<string, { document?: FigmaNode } | null>;
}

export async function getNodeInfo(fileKey: string, nodeId: string): Promise<FigmaNode> {
  const ids = encodeURIComponent(nodeId);
  const res = await fetchWithRetry(
    `${FIGMA_API_BASE}/v1/files/${fileKey}/nodes?ids=${ids}&depth=2`,
    { headers: { 'X-Figma-Token': env().FIGMA_TOKEN } },
  );
  if (res.status === 404) throw new FigmaApiError('figma_node_not_found', `file ${fileKey} not found`);
  if (res.status === 403 || res.status === 401)
    throw new FigmaApiError('unauthorized', `Figma REST auth failed: ${res.status}`);
  if (res.status === 429)
    throw new FigmaApiError('internal_error', `Figma REST rate limited after retries`);
  if (!res.ok) throw new FigmaApiError('internal_error', `Figma REST error: ${res.status}`);

  const json = (await res.json()) as FigmaNodesResponse;
  const entry = json.nodes?.[nodeId];
  if (!entry?.document) {
    throw new FigmaApiError('figma_node_not_found', `node ${nodeId} not found in ${fileKey}`);
  }
  return entry.document;
}

export class FigmaApiError extends Error {
  constructor(
    public code: 'figma_node_not_found' | 'unauthorized' | 'internal_error',
    message: string,
  ) {
    super(message);
    this.name = 'FigmaApiError';
  }
}
