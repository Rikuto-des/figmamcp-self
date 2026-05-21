import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NodeInfoError, nodeInfoForUser } from '../../services/node-info-service.js';
import { log } from '../../logger.js';

const Input = {
  figma_url: z.string().optional(),
  file_key: z.string().optional(),
  node_id: z.string().optional(),
};

const DESCRIPTION =
  'Returns structured JSON metadata (name, type, position, size, fills, text content, child layers, ' +
  'etc.) for a Figma node identified by URL or file_key + node_id. Use this alongside ' +
  'figma_get_screenshot when you need exact text, dimensions, or hierarchy to produce code.';

export function registerGetNodeInfo(server: McpServer, ctx: { userId: string }): void {
  server.registerTool(
    'figma_get_node_info',
    {
      title: 'Get Figma Node Info',
      description: DESCRIPTION,
      inputSchema: Input,
    },
    async (args) => {
      try {
        const info = await nodeInfoForUser({
          userId: ctx.userId,
          figmaUrl: args.figma_url,
          fileKey: args.file_key,
          nodeId: args.node_id,
        });
        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
      } catch (err) {
        log.error('mcp.figma_get_node_info.failed', {
          userId: ctx.userId,
          msg: err instanceof Error ? err.message : String(err),
        });
        const code = err instanceof NodeInfoError ? err.code : 'internal_error';
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error (${code}): ${msg}` }],
        };
      }
    },
  );
}
