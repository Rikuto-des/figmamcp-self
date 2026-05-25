// Builds an McpServer for the embedded (stdio) mode.
// No userId, no auth — a single process serves a single VS Code session.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetScreenshot } from './tools/get-screenshot.js';
import { registerGetNodeInfo } from './tools/get-node-info.js';

export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'figma-mcp',
    version: '1.0.0',
  });
  registerGetScreenshot(server);
  registerGetNodeInfo(server);
  return server;
}
