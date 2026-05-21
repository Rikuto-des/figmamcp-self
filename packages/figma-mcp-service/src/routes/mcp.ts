// MCP transport endpoint. Uses @modelcontextprotocol/sdk's web-standard
// streamable HTTP transport, which accepts a Web Request and returns a Web
// Response — perfect for Hono.

import { Hono } from 'hono';
import { requireAuth, type AuthVariables } from '../auth.js';
import { getOrCreateSession } from '../mcp/transport.js';
import { log } from '../logger.js';

export const mcpRoute = new Hono<{ Variables: AuthVariables }>();
mcpRoute.use('*', requireAuth);

async function handleAll(c: import('hono').Context<{ Variables: AuthVariables }>): Promise<Response> {
  const userId = c.get('userId');
  const sessionId = c.req.header('Mcp-Session-Id') ?? null;
  try {
    const { transport } = await getOrCreateSession({ sessionId, userId });
    return await transport.handleRequest(c.req.raw);
  } catch (err) {
    log.error('mcp.handle_request_failed', {
      userId,
      sessionId,
      msg: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: { code: 'internal_error', message: 'mcp request failed' } }, 500);
  }
}

mcpRoute.post('/mcp', handleAll);
mcpRoute.get('/mcp', handleAll);
mcpRoute.delete('/mcp', handleAll);
