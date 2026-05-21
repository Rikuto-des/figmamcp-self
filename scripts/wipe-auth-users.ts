// themeleon の Auth users を全削除し、figma-mcp-poc 用に POC_EMAIL ユーザーを 1 名作成。
//
// 実行前に必須:
//   - .env に themeleon の SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が入っていること
//   - .env に新しい POC_EMAIL / POC_PASSWORD が入っていること
//   - Stripe Subscriptions を Cancel 済み
//
// 実行:
//   pnpm tsx scripts/wipe-auth-users.ts

import { createClient } from '@supabase/supabase-js';

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const pocEmail = process.env.POC_EMAIL;
  const pocPassword = process.env.POC_PASSWORD;

  if (!url || !serviceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
    process.exit(1);
  }
  if (!pocEmail || !pocPassword) {
    console.error('Missing POC_EMAIL or POC_PASSWORD in env');
    process.exit(1);
  }

  const sb = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. 全 users をリスト
  console.log('[wipe-auth] listing all users...');
  const allUsers: { id: string; email: string | undefined }[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.error(`listUsers failed: ${error.message}`);
      process.exit(1);
    }
    for (const u of data.users) allUsers.push({ id: u.id, email: u.email });
    if (data.users.length < 200) break;
    page++;
  }
  console.log(`[wipe-auth] found ${allUsers.length} users`);
  for (const u of allUsers) console.log(`  - ${u.id}  ${u.email}`);

  // 2. 全 users を削除
  for (const u of allUsers) {
    console.log(`[wipe-auth] deleting ${u.email} (${u.id})...`);
    const { error } = await sb.auth.admin.deleteUser(u.id);
    if (error) {
      console.error(`  deleteUser failed: ${error.message}`);
      process.exit(1);
    }
  }

  // 3. POC ユーザー作成
  console.log(`[wipe-auth] creating POC user ${pocEmail}...`);
  const { data, error } = await sb.auth.admin.createUser({
    email: pocEmail,
    password: pocPassword,
    email_confirm: true,
  });
  if (error || !data.user) {
    console.error(`createUser failed: ${error?.message}`);
    process.exit(1);
  }

  console.log('[wipe-auth] Done.');
  console.log(`POC user id: ${data.user.id}`);
  console.log('Use this id for: pnpm issue-api-key --user <id> --label "..."');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
