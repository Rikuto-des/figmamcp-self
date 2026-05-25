// Figma REST helper — used only for `figma_get_node_info` (returns JSON
// metadata for a node). Images are NEVER fetched via REST in this PoC —
// they're rendered by Playwright in-process.

import { env } from './env.js';
import type { FigmaNode } from '@figma-mcp-poc/shared';

const FIGMA_API_BASE = 'https://api.figma.com';

export class FigmaApiError extends Error {
  constructor(
    public code: 'figma_node_not_found' | 'unauthorized' | 'internal_error',
    message: string,
  ) {
    super(message);
    this.name = 'FigmaApiError';
  }
}

/** fetch with exponential backoff on 429. */
async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    lastRes = res;
    if (attempt < maxRetries) {
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt + 1) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return lastRes!;
}

interface FigmaNodesResponse {
  nodes: Record<string, { document?: FigmaNode } | null>;
}

export async function getNodeInfo(fileKey: string, nodeId: string): Promise<FigmaNode> {
  const token = env().FIGMA_TOKEN;
  if (!token) {
    throw new FigmaApiError('unauthorized', 'FIGMA_TOKEN is not set');
  }
  const ids = encodeURIComponent(nodeId);
  const res = await fetchWithRetry(
    `${FIGMA_API_BASE}/v1/files/${fileKey}/nodes?ids=${ids}&depth=2`,
    { headers: { 'X-Figma-Token': token } },
  );
  if (res.status === 404)
    throw new FigmaApiError('figma_node_not_found', `file ${fileKey} not found`);
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
