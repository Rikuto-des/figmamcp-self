// Verifies per-user isolation: render-service must always pass userId to
// Supabase. We don't hit a real DB — we just observe the calls the service
// makes to the mocked supabase module.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../supabase.js', () => {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  return {
    __calls: calls,
    appendAuditLog: vi.fn(async (args: unknown) => {
      calls.push({ fn: 'appendAuditLog', args: [args] });
    }),
    findCachedAsset: vi.fn(async (args: unknown) => {
      calls.push({ fn: 'findCachedAsset', args: [args] });
      return null;
    }),
    insertAsset: vi.fn(async (args: unknown) => {
      calls.push({ fn: 'insertAsset', args: [args] });
      return {
        id: 'asset-uuid',
        file_key: 'fk',
        node_id: '1:2',
        cache_key: 'ck',
        created_by: (args as { userId: string }).userId,
        storage_path: 'p',
        mime_type: 'image/png',
        width: 10,
        height: 10,
        scale: 2,
        format: 'png',
        file_version: 'v',
        classification: 'internal',
        tier: 'B',
        size_bytes: 1,
        created_at: 'now',
        expires_at: null,
      };
    }),
    uploadAsset: vi.fn(async (args: unknown) => {
      calls.push({ fn: 'uploadAsset', args: [args] });
      return { path: 'storage/path.png', digest: 'd' };
    }),
    createSignedUrl: vi.fn(async () => ({ url: 'https://signed', expiresAt: 'soon' })),
  };
});

vi.mock('../../figma-rest.js', () => ({
  getFileMeta: vi.fn(async () => ({ lastModified: 'v1', version: '1', name: 'n' })),
  FigmaApiError: class extends Error {},
}));

vi.mock('../../render.js', () => ({
  renderNode: vi.fn(async () => ({
    bytes: Buffer.from('png'),
    mimeType: 'image/png',
    width: 10,
    height: 10,
  })),
  RenderError: class extends Error {},
}));

import { renderForUser } from '../../services/render-service.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as supabaseMock from '../../supabase.js';

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabaseMock as any).__calls.length = 0;
});

describe('per-user isolation', () => {
  it('always passes userId to findCachedAsset', async () => {
    await renderForUser({
      userId: 'user-A',
      figmaUrl: 'https://www.figma.com/design/abc/F?node-id=1-2',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (supabaseMock as any).__calls as Array<{ fn: string; args: any[] }>;
    const lookup = calls.find((c) => c.fn === 'findCachedAsset');
    expect(lookup).toBeDefined();
    expect(lookup!.args[0].userId).toBe('user-A');
  });

  it("user A's cache lookup does not include user B's userId", async () => {
    await renderForUser({
      userId: 'user-B',
      figmaUrl: 'https://www.figma.com/design/abc/F?node-id=1-2',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (supabaseMock as any).__calls as Array<{ fn: string; args: any[] }>;
    const lookup = calls.find((c) => c.fn === 'findCachedAsset');
    expect(lookup!.args[0].userId).toBe('user-B');
    expect(lookup!.args[0].userId).not.toBe('user-A');
  });

  it('upload path is prefixed with the requesting userId', async () => {
    await renderForUser({
      userId: 'user-C',
      figmaUrl: 'https://www.figma.com/design/abc/F?node-id=1-2',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (supabaseMock as any).__calls as Array<{ fn: string; args: any[] }>;
    const up = calls.find((c) => c.fn === 'uploadAsset');
    expect(up!.args[0].userId).toBe('user-C');
  });
});
