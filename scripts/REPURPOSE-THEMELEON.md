# themeleon → figma-mcp-poc 転用手順

## 前提
- バックアップ済: `/Users/rikuto/Desktop/themeleon-backup-2026-05-21/`
  - schema.sql (17 KB)
  - data.sql (155 KB, auth/storage 含む)

## 順序

### ステップ 1: Stripe Dashboard で停止 (ユーザー手動 / 10 分)

1. **Subscriptions** → active を全件 Cancel
   - 課金中ユーザー: `itsukitsubasa181@gmail.com` (1 名のみ)
2. **Developers → Webhooks** → themeleon エンドポイント Delete
3. **Developers → API keys** → Secret / Restricted を Roll
4. (任意) `itsukitsubasa181@gmail.com` にサービス終了案内 + 必要なら Refund

### ステップ 2: themeleon app (Cloudflare) を停止

- Cloudflare Workers / Pages の該当プロジェクトを Pause / Delete
- `theme-leon.com` の DNS レコードを削除 or 410 ページへ
- Workers のシークレット (Stripe secret / Supabase keys 等) を削除

### ステップ 3: Supabase の public schema + Storage を wipe

`scripts/wipe-themeleon.sql` を実行する。2 通り:

**A. Supabase Dashboard SQL Editor (簡単・推奨)**
1. https://supabase.com/dashboard/project/nfclpcjssetzyazsifda/sql/new を開く
2. `scripts/wipe-themeleon.sql` 全文をコピペ
3. Run

**B. psql (要 DB password)**
```bash
# DB password は Dashboard → Settings → Database で確認
psql "postgresql://postgres:[PW]@db.nfclpcjssetzyazsifda.supabase.co:5432/postgres" \
  -f scripts/wipe-themeleon.sql
```

確認:
```sql
select count(*) from information_schema.tables where table_schema='public';  -- 0
select count(*) from storage.buckets;                                         -- 0
select count(*) from supabase_migrations.schema_migrations;                   -- 0
```

### ステップ 4: Auth users を wipe + POC ユーザー作成

`.env` を themeleon の URL / SERVICE_ROLE_KEY で埋め、`POC_EMAIL` / `POC_PASSWORD` を新規発行したいメール/パスワードで埋める。

```bash
pnpm tsx scripts/wipe-auth-users.ts
```

→ 既存 2 名 (yourself + itsuki) を削除 → POC_EMAIL ユーザーを 1 名作成。

### ステップ 5: Supabase API キーを Reset (任意だが推奨)

themeleon の anon/service_role キーが旧 Vercel 等に残ってる場合の安全のため:

Dashboard → Settings → API → Reset anon key & service_role key

新しい値を `.env` に反映。

### ステップ 6: プロジェクト名変更 (任意)

Dashboard → Project Settings → General → Name を `figma-mcp-poc` に変更。
ref (URL) は変わらないので、`.env` の `SUPABASE_URL` は手を入れなくて OK。

### ステップ 7: figma-mcp-poc 用の migration を適用

```bash
supabase db push
```

これで:
- `supabase/migrations/20260520000000_init.sql` → assets, audit_log, RLS, storage policy, delete_expired_assets()
- `supabase/migrations/20260601000000_api_keys.sql` → api_keys table

が適用される。

### ステップ 8: Storage バケット作成

Dashboard → Storage → New bucket
- Name: `figma-assets`
- Public: **OFF**
- File size limit: 50 MB
- Allowed MIME types: `image/png`, `image/jpeg`

### ステップ 9: 動作確認

```bash
# サービス起動
pnpm dev

# 別ターミナル
curl http://localhost:3000/healthz

# Bearer Token 発行
pnpm get-token > /tmp/token.txt
TOKEN=$(cat /tmp/token.txt)
echo "FIGMA_MCP_TOKEN=$TOKEN" >> .env

# tools/list
curl -sX POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`figma_get_screenshot` / `figma_get_node_info` が一覧に出れば OK。

### ステップ 10: VS Code 連携

```bash
# シェルに FIGMA_MCP_TOKEN を export
export FIGMA_MCP_TOKEN=$(cat /tmp/token.txt)

# VS Code を本ディレクトリで起動
code .
# Copilot Chat → Agent → Figma URL ペースト
```

---

## ロールバック (万一)

```bash
# 念のため取った backup から復元 (storage.objects は別途復旧不能)
psql "postgresql://postgres:[PW]@db.nfclpcjssetzyazsifda.supabase.co:5432/postgres" \
  < /Users/rikuto/Desktop/themeleon-backup-2026-05-21/schema.sql

psql "postgresql://postgres:[PW]@db.nfclpcjssetzyazsifda.supabase.co:5432/postgres" \
  < /Users/rikuto/Desktop/themeleon-backup-2026-05-21/data.sql
```
