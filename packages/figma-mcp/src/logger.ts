import { env } from './env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const levelOrder: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function shouldLog(level: Level): boolean {
  return levelOrder[level] >= levelOrder[env().LOG_LEVEL];
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  });
  // ALL logs go to stderr. stdout is reserved for MCP JSON-RPC frames
  // — printing to stdout would corrupt the protocol stream.
  console.error(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
