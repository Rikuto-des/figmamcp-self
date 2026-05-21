-- =============================================================================
-- figma-mcp-poc — initial schema
-- See docs/specs/supabase-spec.md for full rationale.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- assets: rendered Figma node screenshots (metadata + cache key)
-- -----------------------------------------------------------------------------
create table if not exists public.assets (
  id              uuid primary key default gen_random_uuid(),
  file_key        text not null,
  node_id         text not null,
  cache_key       text not null,
  created_by      uuid not null references auth.users(id) on delete cascade,
  storage_path    text not null,
  mime_type       text not null default 'image/png',
  width           integer,
  height          integer,
  scale           numeric not null default 2,
  format          text not null default 'png',
  file_version    text,
  classification  text not null default 'internal',
  tier            text not null default 'B',
  size_bytes      integer,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz
);

create unique index if not exists assets_user_cache_idx
  on public.assets (created_by, cache_key);

create index if not exists assets_expires_idx
  on public.assets (created_by, expires_at)
  where expires_at is not null;

create index if not exists assets_file_node_idx
  on public.assets (file_key, node_id);

-- -----------------------------------------------------------------------------
-- audit_log: per-event audit trail for render flow
-- -----------------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  actor       uuid references auth.users(id) on delete set null,
  event       text not null,
  asset_id    uuid references public.assets(id) on delete set null,
  meta        jsonb not null default '{}'::jsonb
);

create index if not exists audit_actor_ts_idx
  on public.audit_log (actor, ts desc);

create index if not exists audit_event_idx
  on public.audit_log (event);

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.assets enable row level security;
alter table public.audit_log enable row level security;

-- assets: own rows read-only via anon JWT.
-- Writes are done via service_role from the worker (RLS bypassed).
drop policy if exists "own assets read" on public.assets;
create policy "own assets read"
  on public.assets for select
  using (created_by = auth.uid());

-- audit_log: own rows read-only.
drop policy if exists "own audit read" on public.audit_log;
create policy "own audit read"
  on public.audit_log for select
  using (actor = auth.uid());

-- -----------------------------------------------------------------------------
-- Storage policy for figma-assets bucket (private)
-- Paths follow: <user_id>/<file_key>/<node_id>/<digest>.png
-- -----------------------------------------------------------------------------
drop policy if exists "own files select" on storage.objects;
create policy "own files select"
  on storage.objects for select
  using (
    bucket_id = 'figma-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- -----------------------------------------------------------------------------
-- Cleanup function: delete expired assets and their storage objects
-- -----------------------------------------------------------------------------
create or replace function public.delete_expired_assets()
returns int
language plpgsql
security definer
as $$
declare
  deleted_count int := 0;
  r record;
begin
  for r in
    select id, storage_path from public.assets
    where expires_at is not null and expires_at < now()
  loop
    delete from storage.objects
    where bucket_id = 'figma-assets' and name = r.storage_path;
    delete from public.assets where id = r.id;
    deleted_count := deleted_count + 1;
  end loop;
  return deleted_count;
end;
$$;

comment on function public.delete_expired_assets() is
  'Deletes assets rows + storage objects where expires_at < now(). Returns count.';
