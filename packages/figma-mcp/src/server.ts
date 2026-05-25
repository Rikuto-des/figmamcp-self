#!/usr/bin/env node
// Embedded MCP server — stdio transport, no HTTP, no Supabase, no auth.
// VS Code / Codespaces spawns this process and talks to it over stdin/stdout
// using MCP JSON-RPC frames. stdout is RESERVED for protocol; everything
// else (logs, errors) goes to stderr via logger.ts.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './mcp/index.js';
import { log } from './logger.js';
import { shutdown } from './render.js';

async function main(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('mcp.stdio.ready', { name: 'figma-mcp', version: '1.0.0' });
}

function bye(): void {
  shutdown().finally(() => process.exit(0));
}
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

main().catch((err) => {
  log.error('mcp.stdio.startup_failed', { msg: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
