-- =============================================================================
-- themeleon → figma-mcp-poc 転用準備: public スキーマ + storage バケット を wipe
--
-- 実行前に必ず以下を完了:
--   1. Stripe Subscriptions を Cancel
--   2. themeleon app (Vercel) を停止
--   3. /Users/rikuto/Desktop/themeleon-backup-2026-05-21/ にバックアップ済み
--
-- 実行方法 (Supabase Dashboard → SQL Editor で全文ペースト → Run、または psql):
--   psql "postgresql://postgres:[PW]@db.nfclpcjssetzyazsifda.supabase.co:5432/postgres" \
--     -f scripts/wipe-themeleon.sql
-- =============================================================================

begin;

-- ----- public schema を一括 drop → 再作成 -----
-- これで themes / generation_log / stripe_payment_log / user_credits /
-- interview_sessions / generated_prs と、関連する RLS ポリシー / index / sequence
-- がまとめて消える。
drop schema if exists public cascade;
create schema public;
grant all on schema public to postgres;
grant all on schema public to anon;
grant all on schema public to authenticated;
grant all on schema public to service_role;
comment on schema public is 'standard public schema';

-- ----- 旧 migration 履歴をクリア -----
-- supabase_migrations.schema_migrations は themeleon の過去 migration を記憶している。
-- figma-mcp-poc の新規 migration を素直に適用させるためクリアする。
truncate table supabase_migrations.schema_migrations;

-- ----- Storage: avatars バケットは Storage API 経由で削除済み -----
-- Supabase が storage.objects / storage.buckets に protect_delete トリガを
-- 仕込んでいるため SQL からは触れない。本スクリプト実行前に以下を実行:
--   curl -X POST  https://<ref>.supabase.co/storage/v1/bucket/avatars/empty  -H "Authorization: Bearer <service_role>"
--   curl -X DELETE https://<ref>.supabase.co/storage/v1/bucket/avatars      -H "Authorization: Bearer <service_role>"

commit;

-- ----- 確認 -----
-- 以下が全部 0 になっていれば wipe 成功:
--   select count(*) from information_schema.tables where table_schema='public';
--   select count(*) from storage.buckets;
--   select count(*) from supabase_migrations.schema_migrations;
