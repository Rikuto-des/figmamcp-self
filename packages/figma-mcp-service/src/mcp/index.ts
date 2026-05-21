// Builds an McpServer bound to a specific user. All tools call services that
// thread userId through every Supabase query → per-user isolation.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetScreenshot } from './tools/get-screenshot.js';
import { registerGetNodeInfo } from './tools/get-node-info.js';

export interface BuildOpts {
  userId: string;
}

export function buildMcpServer(opts: BuildOpts): McpServer {
  const server = new McpServer({
    name: 'figma-mcp-poc',
    version: '0.2.0',
  });
  registerGetScreenshot(server, opts);
  registerGetNodeInfo(server, opts);
  return server;
}
