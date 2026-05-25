// figma_get_screenshot — the headline tool. Renders a Figma node via
// Playwright in the same process, optionally serving from an in-memory
// LRU cache, and returns the bytes as base64. No URLs are ever created.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { computeCacheKey, getCached, setCached } from '../../cache.js';
import { log } from '../../logger.js';
import { renderNode, RenderError } from '../../render.js';
import { normalizeNodeId, parseFigmaUrl } from '../../url-parser.js';

const Input = {
  figma_url: z
    .string()
    .optional()
    .describe('Full Figma URL (e.g. https://www.figma.com/design/...?node-id=1-23)'),
  file_key: z
    .string()
    .regex(/^[A-Za-z0-9]+$/)
    .optional()
    .describe('Figma file key (alternative to figma_url)'),
  node_id: z
    .string()
    .regex(/^[0-9]+[:\-][0-9]+$/)
    .optional()
    .describe('Figma node id like "1:23" or "1-23" (required with file_key)'),
  scale: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe('Render scale (default 2)'),
  force_refresh: z.boolean().optional().describe('Bypass the in-memory cache'),
};

const DESCRIPTION =
  'Use this whenever the user pastes a figma.com URL or asks for a screenshot / image / rendering ' +
  'of a Figma node, component, screen, or frame. Returns a PNG image of the specified node so the ' +
  'model can see the design and produce code or analysis based on it. This is the canonical way to ' +
  'read a Figma design within this workspace.';

function resolveTarget(args: {
  figma_url?: string;
  file_key?: string;
  node_id?: string;
}): { fileKey: string; nodeId: string } {
  if (args.figma_url) {
    const parsed = parseFigmaUrl(args.figma_url);
    if (!parsed) throw new Error('failed to parse figma_url');
    if (!parsed.nodeId) throw new Error('node-id missing in URL');
    return { fileKey: parsed.fileKey, nodeId: parsed.nodeId };
  }
  if (!args.file_key || !args.node_id) {
    throw new Error('figma_url or (file_key + node_id) required');
  }
  return { fileKey: args.file_key, nodeId: normalizeNodeId(args.node_id) };
}

export function registerGetScreenshot(server: McpServer): void {
  server.registerTool(
    'figma_get_screenshot',
    {
      title: 'Get Figma Screenshot',
      description: DESCRIPTION,
      inputSchema: Input,
    },
    async (args) => {
      const t0 = Date.now();
      try {
        const { fileKey, nodeId } = resolveTarget(args);
        const scale = args.scale ?? 2;
        const format = 'png';
        const cacheKey = computeCacheKey({ fileKey, nodeId, format, scale });

        // ── Cache check ──────────────────────────────────────────────────
        if (!args.force_refresh) {
          const hit = getCached(cacheKey);
          if (hit) {
            log.info('tool.get_screenshot.cache_hit', {
              fileKey,
              nodeId,
              durationMs: Date.now() - t0,
            });
            return {
              content: [
                { type: 'image', data: hit.bytes.toString('base64'), mimeType: hit.mimeType },
                {
                  type: 'text',
                  text: JSON.stringify({
                    file_key: fileKey,
                    node_id: nodeId,
                    width: hit.width,
                    height: hit.height,
                    cache_hit: true,
                    rendered_via: 'cache',
                  }),
                },
              ],
            };
          }
        }

        // ── Fresh render via Playwright (in-process) ────────────────────
        log.info('tool.get_screenshot.render_start', { fileKey, nodeId, scale });
        const rendered = await renderNode({ fileKey, nodeId, scale });
        setCached(cacheKey, {
          bytes: rendered.bytes,
          mimeType: rendered.mimeType,
          width: rendered.width,
          height: rendered.height,
        });
        log.info('tool.get_screenshot.complete', {
          fileKey,
          nodeId,
          bytes: rendered.bytes.length,
          width: rendered.width,
          height: rendered.height,
          durationMs: Date.now() - t0,
        });

        return {
          content: [
            {
              type: 'image',
              data: rendered.bytes.toString('base64'),
              mimeType: rendered.mimeType,
            },
            {
              type: 'text',
              text: JSON.stringify({
                file_key: fileKey,
                node_id: nodeId,
                width: rendered.width,
                height: rendered.height,
                cache_hit: false,
                rendered_via: 'playwright',
              }),
            },
          ],
        };
      } catch (err) {
        const code = err instanceof RenderError ? err.code : 'internal_error';
        const msg = err instanceof Error ? err.message : String(err);
        log.error('tool.get_screenshot.failed', { code, msg });
        return {
          isError: true,
          content: [{ type: 'text', text: `Error (${code}): ${msg}` }],
        };
      }
    },
  );
}
