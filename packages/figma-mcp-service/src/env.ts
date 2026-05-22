import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from monorepo root (two dirs up from packages/figma-mcp-service).
// In production (Fly.io / Docker) env vars are injected directly via secrets,
// so config() silently no-ops when the file is absent.
config({ path: resolve(process.cwd(), '../../.env') });

import { z } from 'zod';

const EnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  FIGMA_TOKEN: z.string().min(10),
  PORT: z.coerce.number().int().positive().default(3000),
  STORAGE_BUCKET: z.string().default('figma-assets'),
  SIGNED_URL_TTL_SEC: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  FIGMA_STATE_PATH: z.string().default('.playwright-state/figma.json'),
  FIGMA_STATE_JSON: z.string().optional(),
  // Override for persistent Chrome profile dir (default: auto-detected from FIGMA_STATE_PATH)
  FIGMA_PROFILE_DIR: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
      throw new Error('Invalid environment variables');
    }
    cached = parsed.data;
  }
  return cached;
}
