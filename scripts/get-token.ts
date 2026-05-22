// Sign in to Supabase with POC_EMAIL/POC_PASSWORD and print the access_token.
// Used in Phase 7 to seed FIGMA_MCP_TOKEN before issuing a long-lived API key.
//
// Usage:
//   pnpm get-token
//
// Then paste the printed token into the FIGMA_MCP_TOKEN env var.

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config(); // Load .env from repo root (CWD when running pnpm get-token)

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const email = process.env.POC_EMAIL;
  const password = process.env.POC_PASSWORD;
  if (!url || !anon || !email || !password) {
    console.error('Missing env vars: SUPABASE_URL, SUPABASE_ANON_KEY, POC_EMAIL, POC_PASSWORD');
    process.exit(1);
  }

  const sb = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    console.error(`Sign-in failed: ${error?.message ?? 'no session'}`);
    process.exit(1);
  }

  const expiresIn = data.session.expires_in ?? 3600;
  process.stderr.write(
    `[get-token] Access token (expires in ~${expiresIn}s). Paste into FIGMA_MCP_TOKEN:\n\n`,
  );
  process.stdout.write(data.session.access_token + '\n');
}

main();
