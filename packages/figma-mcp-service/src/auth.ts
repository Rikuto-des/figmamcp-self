// Authentication: accepts both Supabase JWT (Bearer eyJ...) and an internal
// long-lived API key (Bearer fmps_...).
//
// API keys are stored as sha256(raw_key) in public.api_keys.
// Rate limiting: max 60 failed auth attempts per IP per minute (sliding window).

import { createHash } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { supabaseAdmin, verifyJwt } from './supabase.js';
import { log } from './logger.js';

// ── Brute-force rate limiter (in-memory, per IP) ──────────────────────────
// Tracks *failed* auth attempts only. Successful auth resets the counter.
const RATE_WINDOW_MS   = 60_000; // 1 minute sliding window
const RATE_MAX_FAILS   = 60;     // max failed attempts per window per IP

interface RateEntry { count: number; windowStart: number }
const failCounts = new Map<string, RateEntry>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = failCounts.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    // New window
    failCounts.set(ip, { count: 0, windowStart: now });
    return true; // allowed
  }
  return entry.count < RATE_MAX_FAILS;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = failCounts.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    failCounts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count = (entry.count ?? 0) + 1;
  }
}

function resetFailures(ip: string): void {
  failCounts.delete(ip);
}

// Periodically evict stale entries to avoid unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [ip, entry] of failCounts) {
    if (entry.windowStart < cutoff) failCounts.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

export type AuthVariables = { userId: string; authMethod: 'jwt' | 'api_key' };

const API_KEY_PREFIX = 'fmps_';

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function verifyApiKey(raw: string): Promise<{ userId: string } | null> {
  const keyHash = hashApiKey(raw);
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from('api_keys')
    .select('user_id, expires_at, revoked_at')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at) return null;
  if (data.expires_at && new Date(data.expires_at as string).getTime() < Date.now()) return null;

  // best-effort last_used update
  await sb
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('key_hash', keyHash)
    .then(
      () => undefined,
      () => undefined,
    );

  return { userId: data.user_id as string };
}

export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const forwarded = c.req.header('x-forwarded-for');
  const ip = (forwarded ? forwarded.split(',')[0] : undefined)?.trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';

  // Rate limit check before any DB work
  if (!checkRateLimit(ip)) {
    log.warn('auth.rate_limited', { ip });
    return c.json(
      { error: { code: 'rate_limited', message: 'too many failed auth attempts' } },
      429,
    );
  }

  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    recordFailure(ip);
    return c.json({ error: { code: 'unauthorized', message: 'missing bearer token' } }, 401);
  }

  if (token.startsWith(API_KEY_PREFIX)) {
    const result = await verifyApiKey(token);
    if (!result) {
      recordFailure(ip);
      log.warn('auth.api_key_rejected', { ip });
      return c.json({ error: { code: 'unauthorized', message: 'invalid api key' } }, 401);
    }
    resetFailures(ip);
    c.set('userId', result.userId);
    c.set('authMethod', 'api_key');
  } else {
    const result = await verifyJwt(token);
    if (!result) {
      recordFailure(ip);
      log.warn('auth.jwt_rejected', { ip });
      return c.json({ error: { code: 'unauthorized', message: 'invalid token' } }, 401);
    }
    resetFailures(ip);
    c.set('userId', result.userId);
    c.set('authMethod', 'jwt');
  }

  await next();
});
