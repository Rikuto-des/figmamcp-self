-- =============================================================================
-- figma-mcp-poc — Supabase 標準ロール (anon / authenticated / service_role) への
-- GRANT 補正。20260520 init / 20260601 api_keys では postgres のみに権限が付いて
-- いて、service_role でも INSERT/SELECT/UPDATE が拒否されたため追加。
-- =============================================================================

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on public.assets    to service_role;
grant select, insert, update, delete on public.audit_log to service_role;
grant select, insert, update, delete on public.api_keys  to service_role;

grant select on public.assets    to anon, authenticated;
grant select on public.audit_log to anon, authenticated;
grant select on public.api_keys  to anon, authenticated;

-- これから作る public のテーブルにも自動で grant が付くようにする
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

alter default privileges in schema public
  grant select on tables to anon, authenticated;

grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;
