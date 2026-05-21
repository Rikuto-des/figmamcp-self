import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { env } from './env.js';
import type { Asset, Classification, ImageFormat, AuditEvent } from '@figma-mcp-poc/shared';

let cached: SupabaseClient | null = null;
export function supabaseAdmin(): SupabaseClient {
  if (!cached) {
    cached = createClient(env().SUPABASE_URL, env().SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

// JWT verification: uses anon-style getUser(token).
export async function verifyJwt(token: string): Promise<{ userId: string } | null> {
  const { data, error } = await supabaseAdmin().auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id };
}

export interface UploadOpts {
  userId: string;
  fileKey: string;
  nodeIdSafe: string;
  bytes: Buffer;
  mimeType: string;
}

export async function uploadAsset(opts: UploadOpts): Promise<{ path: string; digest: string }> {
  const digest = createHash('sha256').update(opts.bytes).digest('hex').slice(0, 16);
  const path = `${opts.userId}/${opts.fileKey}/${opts.nodeIdSafe}/${digest}.png`;
  const { error } = await supabaseAdmin()
    .storage.from(env().STORAGE_BUCKET)
    .upload(path, opts.bytes, {
      contentType: opts.mimeType,
      upsert: true,
    });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  return { path, digest };
}

export async function createSignedUrl(path: string, ttlSec?: number): Promise<{ url: string; expiresAt: string }> {
  const ttl = ttlSec ?? env().SIGNED_URL_TTL_SEC;
  const { data, error } = await supabaseAdmin()
    .storage.from(env().STORAGE_BUCKET)
    .createSignedUrl(path, ttl);
  if (error || !data?.signedUrl) throw new Error(`signed url failed: ${error?.message}`);
  return {
    url: data.signedUrl,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}

/**
 * Download bytes directly via service_role — no signed URL is ever created.
 * Governance: the bytes never traverse a presigned URL path, so there's no
 * URL artifact that could leak (in memory only, server-internal).
 */
export async function downloadAsset(path: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin()
    .storage.from(env().STORAGE_BUCKET)
    .download(path);
  if (error || !data) throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
  return Buffer.from(await data.arrayBuffer());
}

export interface FindCachedOpts {
  cacheKey: string;
  userId: string;
}
export async function findCachedAsset(opts: FindCachedOpts): Promise<Asset | null> {
  const { data, error } = await supabaseAdmin()
    .from('assets')
    .select('*')
    .eq('cache_key', opts.cacheKey)
    .eq('created_by', opts.userId)
    .maybeSingle();
  if (error) throw new Error(`cache lookup failed: ${error.message}`);
  return (data as Asset | null) ?? null;
}

/** Version-agnostic lookup: find the most recent asset for a node regardless of file_version.
 *  Used to serve cached renders when the Figma REST API is rate-limited. */
export interface FindLatestAssetOpts {
  fileKey: string;
  nodeId: string;
  format: ImageFormat;
  scale: number;
  userId: string;
}
export async function findLatestAsset(opts: FindLatestAssetOpts): Promise<Asset | null> {
  const { data, error } = await supabaseAdmin()
    .from('assets')
    .select('*')
    .eq('file_key', opts.fileKey)
    .eq('node_id', opts.nodeId)
    .eq('format', opts.format)
    .eq('scale', opts.scale)
    .eq('created_by', opts.userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`latest asset lookup failed: ${error.message}`);
  return (data as Asset | null) ?? null;
}

export interface InsertAssetOpts {
  userId: string;
  fileKey: string;
  nodeId: string;
  cacheKey: string;
  storagePath: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  scale: number;
  format: ImageFormat;
  fileVersion: string;
  classification: Classification;
  sizeBytes: number;
}
export async function insertAsset(opts: InsertAssetOpts): Promise<Asset> {
  const ttlSec = opts.classification === 'confidential' ? 300 : 900;
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  const row = {
    file_key: opts.fileKey,
    node_id: opts.nodeId,
    cache_key: opts.cacheKey,
    created_by: opts.userId,
    storage_path: opts.storagePath,
    mime_type: opts.mimeType,
    width: opts.width,
    height: opts.height,
    scale: opts.scale,
    format: opts.format,
    file_version: opts.fileVersion,
    classification: opts.classification,
    tier: 'B' as const,
    size_bytes: opts.sizeBytes,
    expires_at: expiresAt,
  };
  const { data, error } = await supabaseAdmin()
    .from('assets')
    .upsert(row, { onConflict: 'created_by,cache_key' })
    .select('*')
    .single();
  if (error) throw new Error(`insertAsset failed: ${error.message}`);
  return data as Asset;
}

export interface AuditOpts {
  userId: string;
  event: AuditEvent | string;
  assetId?: string;
  meta?: Record<string, unknown>;
}
export async function appendAuditLog(opts: AuditOpts): Promise<void> {
  const { error } = await supabaseAdmin().from('audit_log').insert({
    actor: opts.userId,
    event: opts.event,
    asset_id: opts.assetId ?? null,
    meta: opts.meta ?? {},
  });
  if (error) {
    // log only — audit failure should not break the request
    console.error(JSON.stringify({ level: 'warn', msg: 'audit_log_failed', err: error.message }));
  }
}
