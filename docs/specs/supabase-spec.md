# Supabase 詳細スペック (Phase 1)

## 1. プロジェクト要件

- Region: `ap-northeast-1` (Tokyo)
- Plan: Free (PoC 範囲)
- 構成: Auth + Postgres + Storage (Edge Functions は使わない)

## 2. データベーススキーマ

### 2.1 `public.assets`

レンダリングされた画像のメタデータ + キャッシュキー。

```sql
create table public.assets (
  id              uuid primary key default gen_random_uuid(),
  file_key        text not null,
  node_id         text not null,
  cache_key       text not null,            -- sha256(file_key|node_id|format|scale|file_version)
  created_by      uuid not null references auth.users(id) on delete cascade,
  storage_path    text not null,            -- '<user_id>/<file_key>/<node_id>/<digest>.png'
  mime_type       text not null default 'image/png',
  width           integer,
  height          integer,
  scale           numeric not null default 2,
  format          text not null default 'png',
  file_version    text,                     -- Figma lastModified ISO string
  classification  text not null default 'internal',  -- 'internal' | 'confidential'
  tier            text not null default 'B',         -- 'A' | 'B' | 'C'
  size_bytes      integer,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz                        -- classification 別 TTL で算出
);

-- 同一ユーザーで同 cache_key を重複させない
create unique index assets_user_cache_idx on public.assets (created_by, cache_key);

-- TTL クリーンアップ用
create index assets_expires_idx on public.assets (created_by, expires_at)
  where expires_at is not null;

create index assets_file_node_idx on public.assets (file_key, node_id);
```

### 2.2 `public.audit_log`

操作監査ログ。1 リクエスト = 複数イベント (requested / completed / cache_hit / download_url_issued)。

```sql
create table public.audit_log (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  actor       uuid references auth.users(id) on delete set null,
  event       text not null,              -- 'render.requested' | 'render.completed' | 'render.cache_hit'
                                          -- | 'asset.download_url_issued' | 'render.failed' | ...
  asset_id    uuid references public.assets(id) on delete set null,
  meta        jsonb not null default '{}'::jsonb
);

create index audit_actor_ts_idx on public.audit_log (actor, ts desc);
create index audit_event_idx on public.audit_log (event);
```

### 2.3 RLS (Row Level Security)

両テーブルで RLS を有効化。worker は service_role でアクセスするため bypass されるが、ダッシュボード / mcp-server (anon + JWT) からの直接参照は RLS で保護される。

```sql
alter table public.assets enable row level security;
alter table public.audit_log enable row level security;

-- 自分の assets だけ select 可能
create policy "own assets read"
  on public.assets for select
  using (created_by = auth.uid());

-- assets への insert/update/delete は service_role のみ (worker 経由)
-- 個人 anon key からは書き込めないようにポリシーを敢えて作らない

-- 自分の audit_log だけ select 可能
create policy "own audit read"
  on public.audit_log for select
  using (actor = auth.uid());
```

### 2.4 Storage バケットとポリシー

- バケット名: `figma-assets`
- Public: **OFF**
- File size limit: 50 MB
- Allowed MIME types: `image/png`, `image/jpeg`

```sql
-- storage.objects に対する RLS ポリシー (Supabase ダッシュボードか SQL で設定)
-- パスは <user_id>/<file_key>/<node_id>/<digest>.png 形式
create policy "own files select"
  on storage.objects for select
  using (
    bucket_id = 'figma-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
```

書き込みは service_role 経由 (worker) のみ。anon からの insert/update/delete ポリシーは作らない。

### 2.5 TTL クリーンアップ関数

機密度別 TTL:
- `confidential` → 5 分 (300 秒)
- `internal` → 15 分 (900 秒)
- (PoC では署名 URL TTL と同じ。本番では cache TTL と署名 URL TTL を分離検討)

```sql
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
    -- Storage object 削除 (service_role 権限が必要なため、別途 supabase-js から呼ぶ運用も検討)
    delete from storage.objects
    where bucket_id = 'figma-assets' and name = r.storage_path;
    -- DB 行削除
    delete from public.assets where id = r.id;
    deleted_count := deleted_count + 1;
  end loop;
  return deleted_count;
end;
$$;
```

PoC では cron 実行は省略。手動 `select public.delete_expired_assets();` で運用。

## 3. Auth

- Provider: Email + Password
- 開発者個人 1 アカウント (`POC_EMAIL` / `POC_PASSWORD`)
- Email Confirm は Dashboard で手動で Confirmed に設定
- 確認 curl:
  ```bash
  curl -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$POC_EMAIL\",\"password\":\"$POC_PASSWORD\"}"
  ```
  → `access_token` が返ること

## 4. 手順 (Manual)

### Dashboard 作業
1. New Project → name `figma-mcp-poc`, region `ap-northeast-1`, Postgres password を控える
2. Project Settings → API
   - URL: `SUPABASE_URL` に転記
   - anon public key: `SUPABASE_ANON_KEY` に転記
   - service_role secret: `SUPABASE_SERVICE_ROLE_KEY` に転記 (**コミット禁止**)
3. Authentication → Users → Add User
   - Email: `POC_EMAIL` の値
   - Password: `POC_PASSWORD` の値
   - **Auto Confirm User** ON
4. Storage → Create bucket
   - Name: `figma-assets`
   - Public: OFF
   - File size limit: 50 MB

### CLI 作業
```bash
# (初回のみ) supabase CLI を install
brew install supabase/tap/supabase

# プロジェクトとリンク
supabase login
supabase link --project-ref <YOUR-PROJECT-REF>

# migration 適用
supabase db push
```

### 確認
- Table Editor で `assets`, `audit_log` が見える
- Storage で `figma-assets` バケットが見える
- 上記 curl で access_token が返る

## 5. 注意事項

- `SUPABASE_SERVICE_ROLE_KEY` は **renderer-worker / figma-mcp-service のみ** で使う。mcp-server (stdio) には**絶対に**渡さない (`docs/CLAUDE.md` の「やってはいけないこと」参照)
- migration 番号は ISO 日付ベース: `20260520000000_init.sql` のように
- RLS は worker が service_role でバイパスするが、コード側で `.eq('created_by', userId)` を明示することで Phase 7 の per-user 分離を担保する
