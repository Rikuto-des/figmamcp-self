import { createHash } from 'node:crypto';

export interface CacheKeyOpts {
  fileKey: string;
  nodeId: string;
  format: string;
  scale: number;
  fileVersion: string;
}

export function computeCacheKey(opts: CacheKeyOpts): string {
  return createHash('sha256')
    .update([opts.fileKey, opts.nodeId, opts.format, opts.scale, opts.fileVersion].join('|'))
    .digest('hex');
}
