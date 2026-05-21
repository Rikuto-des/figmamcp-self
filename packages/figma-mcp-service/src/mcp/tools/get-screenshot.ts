import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RenderForUserError, renderForUser } from '../../services/render-service.js';
import { log } from '../../logger.js';

const Input = {
  figma_url: z.string().optional().describe('Full Figma URL (e.g. https://www.figma.com/design/...?node-id=1-23)'),
  file_key: z.string().regex(/^[A-Za-z0-9]+$/).optional().describe('Figma file key (alternative to figma_url)'),
  node_id:  z.string().regex(/^[0-9]+[:\-][0-9]+$/).optional().describe('Figma node id like "1:23" or "1-23" (required with file_key)'),
  format: z.enum(['png', 'jpg']).optional().describe('Image format (default png)'),
  scale: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('Render scale (default 2)'),
};

const DESCRIPTION =
  'Use this whenever the user pastes a figma.com URL or asks for a screenshot / image / rendering ' +
  'of a Figma node, component, screen, or frame. Returns a PNG image of the specified node so the ' +
  'model can see the design and produce code or analysis based on it. This is the canonical way to ' +
  'read a Figma design within this workspace.';

export function registerGetScreenshot(server: McpServer, ctx: { userId: string }): void {
  server.registerTool(
    'figma_get_screenshot',
    {
      title: 'Get Figma Screenshot',
      description: DESCRIPTION,
      inputSchema: Input,
    },
    async (args) => {
      try {
        const render = await renderForUser({
          userId: ctx.userId,
          figmaUrl: args.figma_url,
          fileKey: args.file_key,
          nodeId: args.node_id,
          format: args.format,
          scale: args.scale,
        });

        // No signed URL involved: bytes flow Buffer → base64 in-process.
        // Governance: no transient public URL is ever created for these bytes.
        const base64 = render.bytes.toString('base64');

        return {
          content: [
            {
              type: 'image',
              data: base64,
              mimeType: render.mime_type,
            },
            {
              type: 'text',
              text: JSON.stringify({
                asset_id: render.asset_id,
                file_key: render.file_key,
                node_id: render.node_id,
                width: render.width,
                height: render.height,
                cache_hit: render.cache_hit,
                rendered_via: render.rendered_via,
                bytes_path: 'in-process buffer (no signed URL minted)',
              }),
            },
          ],
        };
      } catch (err) {
        log.error('mcp.figma_get_screenshot.failed', {
          userId: ctx.userId,
          msg: err instanceof Error ? err.message : String(err),
        });
        const code = err instanceof RenderForUserError ? err.code : 'internal_error';
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error (${code}): ${msg}` }],
        };
      }
    },
  );
}
