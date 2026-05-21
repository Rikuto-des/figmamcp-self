// Issue a long-lived API key for a specific Supabase user. The raw key is
// printed to stdout exactly once; only its sha256 hash is stored in the DB.
//
// Usage:
//   pnpm issue-api-key --user <auth.users.id> --label "rikuto/laptop" [--days 90]
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

interface Args {
  user: string;
  label?: string;
  days?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') out.user = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--days') out.days = Number(argv[++i]);
  }
  if (!out.user) {
    console.error('Usage: pnpm issue-api-key --user <uuid> [--label <text>] [--days <n>]');
    process.exit(1);
  }
  return out as Args;
}

function base62(n: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const rawKey = `fmps_${base62(32)}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const expiresAt = args.days
    ? new Date(Date.now() + args.days * 86_400_000).toISOString()
    : null;

  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { error } = await sb.from('api_keys').insert({
    user_id: args.user,
    key_hash: keyHash,
    label: args.label ?? null,
    expires_at: expiresAt,
  });

  if (error) {
    console.error(`Insert failed: ${error.message}`);
    process.exit(1);
  }

  process.stderr.write(
    `[issue-api-key] Created API key for user=${args.user} label=${args.label ?? ''} expires=${expiresAt ?? 'never'}\n`,
  );
  process.stderr.write(`[issue-api-key] Store this token securely — it is shown only once:\n\n`);
  process.stdout.write(rawKey + '\n');
}

main();
