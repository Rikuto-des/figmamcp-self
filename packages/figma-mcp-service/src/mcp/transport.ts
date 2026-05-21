// Session management for the MCP HTTP transport. Each session is identified by
// the Mcp-Session-Id header; we keep an in-memory map keyed by that id.
//
// Important: with min_machines_running = 1 (Fly.io), sessions never need to
// hop between processes. If we ever scale out, this map must move to Redis.

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { randomUUID } from 'node:crypto';
import { buildMcpServer } from './index.js';
import { log } from '../logger.js';

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  userId: string;
}

const sessions = new Map<string, Session>();

export interface GetOrCreateOpts {
  sessionId: string | null;
  userId: string;
}

export async function getOrCreateSession(opts: GetOrCreateOpts): Promise<Session> {
  if (opts.sessionId) {
    const existing = sessions.get(opts.sessionId);
    if (existing) {
      // Defensive: if a different user reuses someone else's session id, reject.
      if (existing.userId !== opts.userId) {
        throw new Error('session belongs to a different user');
      }
      return existing;
    }
  }

  const newId = opts.sessionId ?? randomUUID();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => newId,
    onsessionclosed: () => {
      sessions.delete(newId);
      log.info('mcp.session_closed', { sessionId: newId });
    },
  });

  const server = buildMcpServer({ userId: opts.userId });
  await server.connect(transport);

  const session: Session = { transport, userId: opts.userId };
  sessions.set(newId, session);
  log.info('mcp.session_created', { sessionId: newId, userId: opts.userId });
  return session;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function sessionCount(): number {
  return sessions.size;
}
