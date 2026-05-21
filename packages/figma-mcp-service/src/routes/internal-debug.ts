// Legacy HTTP endpoints kept under /internal-debug for development & ops
// debugging. Production traffic should go through /mcp.

import { Hono } from 'hono';
import { z } from 'zod';
import type { ErrorCode, ErrorResponse } from '@figma-mcp-poc/shared';
import { requireAuth, type AuthVariables } from '../auth.js';
import { RenderForUserError, renderForUser } from '../services/render-service.js';
import { NodeInfoError, nodeInfoForUser } from '../services/node-info-service.js';

// Strict validation to prevent SSRF / path traversal via raw file_key or node_id
const FILE_KEY_RE = /^[A-Za-z0-9]+$/;
const NODE_ID_RE  = /^[0-9]+[:\-][0-9]+$/;

const RenderBody = z.object({
  figma_url: z.string().optional(),
  file_key: z.string().regex(FILE_KEY_RE, 'file_key must be alphanumeric').optional(),
  node_id:  z.string().regex(NODE_ID_RE,  'node_id must be "int:int" or "int-int"').optional(),
  format: z.enum(['png', 'jpg']).default('png'),
  scale: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  force_refresh: z.boolean().default(false),
  classification: z.enum(['internal', 'confidential']).default('internal'),
});

const NodeInfoBody = z.object({
  figma_url: z.string().optional(),
  file_key: z.string().regex(FILE_KEY_RE, 'file_key must be alphanumeric').optional(),
  node_id:  z.string().regex(NODE_ID_RE,  'node_id must be "int:int" or "int-int"').optional(),
});

type AnyStatus = 400 | 401 | 403 | 404 | 422 | 500 | 504;
function asStatus(n: number): AnyStatus {
  return ([400, 401, 403, 404, 422, 500, 504] as const).includes(n as AnyStatus)
    ? (n as AnyStatus)
    : 500;
}

export const internalDebugRoute = new Hono<{ Variables: AuthVariables }>();
internalDebugRoute.use('*', requireAuth);

internalDebugRoute.post('/internal-debug/render', async (c) => {
  const userId = c.get('userId');
  const parsed = RenderBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json<ErrorResponse>(
      { error: { code: 'invalid_request', message: parsed.error.message } },
      400,
    );
  }
  const body = parsed.data;
  try {
    const res = await renderForUser({
      userId,
      figmaUrl: body.figma_url,
      fileKey: body.file_key,
      nodeId: body.node_id,
      format: body.format,
      scale: body.scale,
      forceRefresh: body.force_refresh,
      classification: body.classification,
    });
    // Strip bytes (not JSON-serializable) — internal-debug returns metadata only.
    // Governance: no signed_url exists in the result either; bytes flow only
    // through the MCP tool path which base64-encodes in-process.
    const { bytes: _bytes, mime_type: _mt, ...safe } = res;
    return c.json({ ...safe, size_bytes: res.bytes.length });
  } catch (err) {
    if (err instanceof RenderForUserError) {
      return c.json<ErrorResponse>(
        { error: { code: err.code as ErrorCode, message: err.message } },
        asStatus(err.httpStatus),
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json<ErrorResponse>({ error: { code: 'internal_error', message: msg } }, 500);
  }
});

internalDebugRoute.post('/internal-debug/node-info', async (c) => {
  const userId = c.get('userId');
  const parsed = NodeInfoBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json<ErrorResponse>(
      { error: { code: 'invalid_request', message: parsed.error.message } },
      400,
    );
  }
  const body = parsed.data;
  try {
    const res = await nodeInfoForUser({
      userId,
      figmaUrl: body.figma_url,
      fileKey: body.file_key,
      nodeId: body.node_id,
    });
    return c.json(res);
  } catch (err) {
    if (err instanceof NodeInfoError) {
      return c.json<ErrorResponse>(
        { error: { code: err.code as ErrorCode, message: err.message } },
        asStatus(err.httpStatus),
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json<ErrorResponse>({ error: { code: 'internal_error', message: msg } }, 500);
  }
});
