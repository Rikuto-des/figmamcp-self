// DB row types that mirror the schema in supabase/migrations/20260520000000_init.sql.
// See docs/specs/supabase-spec.md for column-level rationale.

import type { Classification, ImageFormat, Tier } from './api.js';

export interface Asset {
  id: string;
  file_key: string;
  node_id: string;
  cache_key: string;
  created_by: string;
  storage_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  scale: number;
  format: ImageFormat;
  file_version: string | null;
  classification: Classification;
  tier: Tier;
  size_bytes: number | null;
  created_at: string; // ISO timestamptz
  expires_at: string | null;
}

export type AuditEvent =
  | 'render.requested'
  | 'render.completed'
  | 'render.cache_hit'
  | 'render.failed'
  | 'asset.download_url_issued'
  | 'node_info.requested'
  | 'node_info.completed';

export interface AuditLog {
  id: number;
  ts: string;
  actor: string | null;
  event: AuditEvent | string;
  asset_id: string | null;
  meta: Record<string, unknown>;
}
