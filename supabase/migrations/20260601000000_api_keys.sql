-- =============================================================================
-- figma-mcp-poc — API keys for remote MCP (Phase 7)
-- See docs/specs/remote-mcp-spec.md §8.3
-- =============================================================================

create table if not exists public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  key_hash      text not null unique,            -- sha256(raw_key)
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz
);

create index if not exists api_keys_user_idx on public.api_keys (user_id);

alter table public.api_keys enable row level security;

-- Owners can see their own keys (metadata only — key_hash is hash, not raw key).
drop policy if exists "own api keys" on public.api_keys;
create policy "own api keys"
  on public.api_keys for select
  using (user_id = auth.uid());
