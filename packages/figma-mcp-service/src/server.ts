import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env.js';
import { log } from './logger.js';
import { healthzRoute } from './routes/healthz.js';
import { mcpRoute } from './routes/mcp.js';
import { internalDebugRoute } from './routes/internal-debug.js';
import { shutdown } from './render.js';

const app = new Hono();
app.route('/', healthzRoute);
app.route('/', mcpRoute);
app.route('/', internalDebugRoute);

const port = env().PORT;

serve({ fetch: app.fetch, port }, (info) => {
  log.info('server.listening', { port: info.port });
});

function bye(): void {
  shutdown().finally(() => process.exit(0));
}
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
