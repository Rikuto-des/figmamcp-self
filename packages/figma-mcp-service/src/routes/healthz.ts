import { Hono } from 'hono';
import type { HealthzResponse } from '@figma-mcp-poc/shared';
import { isBrowserReady } from '../render.js';

const startedAt = Date.now();
const VERSION = '0.1.0';

export const healthzRoute = new Hono();

healthzRoute.get('/healthz', async (c) => {
  const browserReady = await isBrowserReady();
  return c.json<HealthzResponse>({
    status: 'ok',
    browser_ready: browserReady,
    uptime_sec: Math.round((Date.now() - startedAt) / 1000),
    version: VERSION,
  });
});
