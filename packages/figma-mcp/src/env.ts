// Embedded mode: no Supabase, no Fly.io, no HTTP, no auth.
// The only env vars that matter are Playwright session paths and an
// optional Figma REST PAT (used solely for the figma_get_node_info tool —
// node JSON only, never images).

import { z } from 'zod';

const EnvSchema = z.object({
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Where Playwright stores the Figma browser session. Local dev default
  // matches scripts/login-figma.ts which creates this directory.
  FIGMA_STATE_PATH: z.string().default('.playwright-state/figma.json'),
  FIGMA_PROFILE_DIR: z.string().optional(),
  // Codespaces / CI: base64-encoded storageState JSON (alternative to the file path)
  FIGMA_STATE_JSON: z.string().optional(),

  // OPTIONAL: Figma REST PAT (only used by figma_get_node_info for node JSON).
  // Images NEVER go through REST — they're rendered by Playwright in-process.
  FIGMA_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      // stderr only — stdout is reserved for MCP JSON-RPC frames
      console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
      throw new Error('Invalid environment variables');
    }
    cached = parsed.data;
  }
  return cached;
}
