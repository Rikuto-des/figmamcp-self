// figma_get_node_info — calls Figma's /v1/files/:key/nodes endpoint to get
// node JSON (text, layout, hierarchy). REST is fine here — this endpoint
// returns JSON only, never images on public S3.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { env } from '../../env.js';
import { FigmaApiError, getNodeInfo } from '../../figma-rest.js';
import { log } from '../../logger.js';
import { normalizeNodeId, parseFigmaUrl } from '../../url-parser.js';

const Input = {
  figma_url: z.string().optional(),
  file_key: z.string().optional(),
  node_id: z.string().optional(),
};

const DESCRIPTION =
  'Returns structured JSON metadata (name, type, position, size, fills, text content, child layers, ' +
  'etc.) for a Figma node identified by URL or file_key + node_id. Use this alongside ' +
  'figma_get_screenshot when you need exact text, dimensions, or hierarchy to produce code.';

function resolveTarget(args: {
  figma_url?: string;
  file_key?: string;
  node_id?: string;
}): { fileKey: string; nodeId: string } {
  if (args.figma_url) {
    const parsed = parseFigmaUrl(args.figma_url);
    if (!parsed?.nodeId) throw new Error('failed to parse figma_url');
    return { fileKey: parsed.fileKey, nodeId: parsed.nodeId };
  }
  if (!args.file_key || !args.node_id) {
    throw new Error('figma_url or (file_key + node_id) required');
  }
  return { fileKey: args.file_key, nodeId: normalizeNodeId(args.node_id) };
}

export function registerGetNodeInfo(server: McpServer): void {
  server.registerTool(
    'figma_get_node_info',
    {
      title: 'Get Figma Node Info',
      description: DESCRIPTION,
      inputSchema: Input,
    },
    async (args) => {
      try {
        if (!env().FIGMA_TOKEN) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  'Error (no_figma_token): figma_get_node_info needs FIGMA_TOKEN (a Figma personal access token). ' +
                  'Either set it in your environment, or just use figma_get_screenshot which renders without REST.',
              },
            ],
          };
        }
        const { fileKey, nodeId } = resolveTarget(args);
        const node = await getNodeInfo(fileKey, nodeId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ file_key: fileKey, node_id: nodeId, node }, null, 2),
            },
          ],
        };
      } catch (err) {
        const code = err instanceof FigmaApiError ? err.code : 'internal_error';
        const msg = err instanceof Error ? err.message : String(err);
        log.error('tool.get_node_info.failed', { code, msg });
        return {
          isError: true,
          content: [{ type: 'text', text: `Error (${code}): ${msg}` }],
        };
      }
    },
  );
}
