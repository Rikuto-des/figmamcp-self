// In-memory LRU cache for rendered Figma screenshots.
//
// Lives in the same process as the MCP server. No external storage, no
// signed URLs, no persistence across restarts. Bytes stay in RAM, indexed
// by (fileKey, nodeId, format, scale).
//
// Cache invalidation: we don't poll Figma for freshness. Cache entries
// expire after TTL_MS or get evicted when the LRU reaches MAX_ENTRIES.
// Pass force=true through the tool input to bypass on demand.

import { createHash } from 'node:crypto';

const MAX_ENTRIES = 50;          // ~50 screenshots ≈ low tens of MB
const TTL_MS = 15 * 60_000;      // 15 min — short enough to feel fresh

export interface CacheKeyOpts {
  fileKey: string;
  nodeId: string;
  format: string;
  scale: number;
}

export interface CachedRender {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

interface Entry extends CachedRender {
  expiresAt: number;
}

const store = new Map<string, Entry>(); // Map preserves insertion order → LRU via re-set

export function computeCacheKey(opts: CacheKeyOpts): string {
  return createHash('sha256')
    .update([opts.fileKey, opts.nodeId, opts.format, opts.scale].join('|'))
    .digest('hex');
}

export function getCached(key: string): CachedRender | null {
  const e = store.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  // Move to end (most recently used)
  store.delete(key);
  store.set(key, e);
  return { bytes: e.bytes, mimeType: e.mimeType, width: e.width, height: e.height };
}

export function setCached(key: string, value: CachedRender): void {
  store.set(key, { ...value, expiresAt: Date.now() + TTL_MS });
  // Evict oldest until under cap
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function cacheStats(): { entries: number; max: number; ttlMs: number } {
  return { entries: store.size, max: MAX_ENTRIES, ttlMs: TTL_MS };
}
