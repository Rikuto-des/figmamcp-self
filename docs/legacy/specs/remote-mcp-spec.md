# remote-mcp-spec — リモート MCP 化 (Phase 7)

## 1. 目的と前提

Phase 4 までで完成した stdio MCP server を HTTP/SSE トランスポートに移行し、**VS Code から直接 HTTPS で接続するリモートサービス化** する。これにより:

- Codespaces / local VS Code 両方から同じ URL に接続 → mcp-server のコード・credentials を dev 機側に置く必要がなくなる
- credentials (Supabase service_role, Figma Web セッション, Figma PAT) はサーバー側のみに存在
- mcp-server コード更新が中央集約
- 監査ログをサーバー側 100% 制覇

**前提**: Phase 6 まで完了し、stdio 版が end-to-end で動いている状態から開始する。

## 2. アーキテクチャ判断: merge vs separate

```
[Option A: Merge - 推奨]                     [Option B: Separate]

VS Code                                       VS Code
   │ HTTPS                                       │ HTTPS
   ▼                                             ▼
┌─────────────────────────┐                   ┌──────────────┐
│ figma-mcp-service       │                   │ mcp-server   │
│  - POST /mcp            │                   │  - POST /mcp │
│  - Playwright (in-proc) │                   └──────┬───────┘
│  - Supabase クライアント│                          │ HTTP (internal)
└─────────────────────────┘                          ▼
                                              ┌──────────────┐
                                              │ worker       │
                                              │  - Playwright│
                                              └──────────────┘
```

**Merge (推奨) の理由:**
- デプロイが 1 サービスで済む
- 内部 HTTP 呼び出しがなくなる → レイテンシ低、エラーポイント減
- credentials を 1 箇所で管理
- Phase 4 と Phase 3 で別パッケージにしていた境界が、リモート化では自然に消える

**Separate の理由:**
- MCP プロトコル層と Playwright 層を独立スケール
- 将来別の Worker (例: Tier A プラグイン経由) を差し替えやすい

PoC 範囲では複雑さを下げる方を選び、**Merge** で進める。

## 3. プロジェクト構成変更

```diff
  packages/
    shared/                              # そのまま
-   mcp-server/                          # 削除
-   renderer-worker/                     # リネーム
+   figma-mcp-service/                   # 統合先 (旧 renderer-worker)
      src/
        server.ts                        # Hono アプリ起動 + MCP transport
+       mcp/
+         index.ts                       # McpServer インスタンス組み立て
+         tools/
+           get-screenshot.ts            # 旧 mcp-server からツール定義移植
+           get-node-info.ts
+         transport.ts                   # StreamableHTTPServerTransport セットアップ
        render.ts                        # そのまま
        figma-rest.ts                    # そのまま
        supabase.ts                      # そのまま
        url-parser.ts                    # そのまま
        auth.ts                          # Bearer 検証 (内部 HTTP 用は削除可)
        cache.ts                         # そのまま
        routes/
-         render.ts                      # 削除 (内部 HTTP 廃止)
-         node-info.ts                   # 削除
+         mcp.ts                         # POST /mcp ハンドラ
          healthz.ts                     # そのまま
```

旧 `mcp-server` パッケージの URL パーサ・ロギング規約は不要になる:
- stdio 制約がないので `console.log` 普通に使える
- token-store (ローカル session.json) も不要

## 4. 依存パッケージ変更

`packages/figma-mcp-service/package.json` (旧 renderer-worker から):

```diff
  "dependencies": {
    "hono": "^4",
    "@hono/node-server": "^1",
    "playwright": "^1.49",
    "@supabase/supabase-js": "^2",
    "zod": "^3",
+   "@modelcontextprotocol/sdk": "^1",
    "@figma-mcp-poc/shared": "workspace:*"
  }
```

## 5. MCP transport: StreamableHTTPServerTransport

`@modelcontextprotocol/sdk` の HTTP transport を使う。stdio との違い:
- 単一の POST /mcp エンドポイントが JSON-RPC を受ける
- 長時間応答は SSE ストリームで返す
- セッション ID は `Mcp-Session-Id` ヘッダで管理

```ts
// src/mcp/transport.ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';

const sessions = new Map<string, StreamableHTTPServerTransport>();

export function getOrCreateTransport(sessionId: string | null): {
  transport: StreamableHTTPServerTransport;
  isNew: boolean;
} {
  if (sessionId && sessions.has(sessionId)) {
    return { transport: sessions.get(sessionId)!, isNew: false };
  }
  const newId = sessionId ?? randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newId,
    onsessionclosed: () => sessions.delete(newId),
  });
  sessions.set(newId, transport);
  return { transport, isNew: true };
}
```

## 6. POST /mcp ハンドラ

```ts
// src/routes/mcp.ts
import { Hono } from 'hono';
import { getOrCreateTransport } from '../mcp/transport.js';
import { buildMcpServer } from '../mcp/index.js';
import { requireBearer, type AuthContext } from '../auth.js';

export const mcpRoute = new Hono<{ Variables: AuthContext }>();

mcpRoute.use('*', requireBearer);

mcpRoute.post('/mcp', async (c) => {
  const sessionId = c.req.header('Mcp-Session-Id') ?? null;
  const { transport, isNew } = getOrCreateTransport(sessionId);

  if (isNew) {
    const server = buildMcpServer({ userId: c.get('userId') });
    await server.connect(transport);
  }

  // Hono の Request/Response を Node の req/res に橋渡し
  const { req, res } = toNodeHttp(c);
  await transport.handleRequest(req, res, await c.req.json());
  return c.body(null);
});

// GET /mcp (SSE notifications) と DELETE /mcp (session 終了) も同様
mcpRoute.get('/mcp', async (c) => { /* ... */ });
mcpRoute.delete('/mcp', async (c) => { /* ... */ });
```

Hono と Node http の橋渡しが必要。`@hono/node-server` の `serve` 経由なら `c.env.incoming` / `c.env.outgoing` で取得可能 (バージョンによる)。最新で動かない場合は Express でやるか、SDK の helper を待つ。

## 7. McpServer の組み立て (per-session)

セッションごとに userId を bind した McpServer を作る。これにより、ツール内部で `userId` を closure で参照できる。

```ts
// src/mcp/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetScreenshot } from './tools/get-screenshot.js';
import { registerGetNodeInfo } from './tools/get-node-info.js';

export function buildMcpServer(ctx: { userId: string }): McpServer {
  const server = new McpServer({
    name: 'figma-mcp-poc',
    version: '0.2.0',
  });
  registerGetScreenshot(server, ctx);
  registerGetNodeInfo(server, ctx);
  return server;
}
```

ツール側は ctx.userId を受け取って Supabase 操作に渡す:

```ts
// src/mcp/tools/get-screenshot.ts (要点)
export function registerGetScreenshot(server: McpServer, ctx: { userId: string }) {
  server.registerTool('figma_get_screenshot', { /* description は stdio 版と同一 */ },
    async (input) => {
      const target = input.figma_url ? parseFigmaUrl(input.figma_url) : { ... };
      const result = await renderForUser({
        userId: ctx.userId,
        fileKey: target.fileKey,
        nodeId: target.nodeId,
        ...
      });
      // signed_url から画像を取って base64 化して返す
      return { content: [...] };
    }
  );
}
```

旧 mcp-server では HTTP で worker を叩いていた部分が、ここでは関数呼び出しになる (`renderForUser`)。

## 8. 認証: Bearer Token (Supabase JWT)

リモート化に伴い、VS Code が認証ヘッダを送るモデルに変える。

### 8.1 認証ミドルウェア

```ts
// src/auth.ts
import { createMiddleware } from 'hono/factory';
import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

export type AuthContext = { userId: string };

export const requireBearer = createMiddleware<{ Variables: AuthContext }>(
  async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return c.json({ error: 'no token' }, 401);

    const { data, error } = await sb.auth.getUser(token);
    if (error || !data.user) return c.json({ error: 'invalid token' }, 401);

    c.set('userId', data.user.id);
    await next();
  }
);
```

stdio 版 worker の `requireAuth` と中身は同じ。今は MCP リクエストにも適用する点が違う。

### 8.2 開発者向けトークン取得スクリプト

VS Code に置く Bearer Token を開発者がどう手に入れるか。PoC では:

```ts
// scripts/get-token.ts (新規)
import { createClient } from '@supabase/supabase-js';
import readline from 'node:readline';

async function main() {
  const url = process.env.SUPABASE_URL!;
  const anon = process.env.SUPABASE_ANON_KEY!;
  const sb = createClient(url, anon, { auth: { persistSession: false } });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = await new Promise<string>(r => rl.question('Email: ', r));
  const password = await new Promise<string>(r => rl.question('Password: ', r));
  rl.close();

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    console.error('Auth failed:', error?.message);
    process.exit(1);
  }

  console.log('');
  console.log('Access token (paste into env as FIGMA_MCP_TOKEN):');
  console.log('');
  console.log(data.session.access_token);
  console.log('');
  console.log(`Expires in: ${data.session.expires_in}s (~1 hour)`);
  console.log('Refresh by re-running this script.');
}

main();
```

開発者は:
```bash
pnpm tsx scripts/get-token.ts
# 出力されたトークンを Codespaces secret や local の .env / shell rc に置く
```

### 8.3 トークン寿命と更新

Supabase access_token は 1 時間。短い。選択肢:

| 案 | 内容 | PoC 適合 |
|---|---|---|
| A. 1 時間ごと再発行 | 開発者が `pnpm tsx scripts/get-token.ts` を再実行 | △ 手間 |
| B. サーバー側 refresh | refresh_token も VS Code に渡す | × OAuth 化に近づく |
| C. 長寿命 API Key 発行 | サーバー独自の長寿命トークンを管理 | ○ 簡単、PoC 向き |
| D. OAuth Device Flow | VS Code で本格 OAuth | × PoC 範囲外 |

**PoC では C を採用**。専用テーブルとエンドポイントを追加:

```sql
create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  key_hash      text not null unique,  -- argon2 or sha256
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz
);

create index api_keys_user_idx on public.api_keys(user_id);
```

`requireBearer` を拡張: Bearer の prefix で分岐
- `Bearer eyJ...` (JWT) → Supabase 検証 (短期、開発初期)
- `Bearer fmps_xxx` (独自) → api_keys テーブル照合 (長期、運用時)

独自キー発行スクリプト:
```ts
// scripts/issue-api-key.ts
// 引数: user_id (admin が指定), label, valid_days
// 出力: 1 回限り表示される fmps_ 形式のキー
```

### 8.4 認可: per-user RLS との関係

ユーザー識別子は `userId` (`auth.users.id`)。Phase 1 で設定済みの RLS (`created_by = auth.uid()`) は worker 側が service_role でアクセスしているので bypass されるが、worker のコード内で **常に created_by = userId** を明示的に書く規律で代替する。

例:
```ts
// assets insert
await supabase.from('assets').insert({
  ...row,
  created_by: ctx.userId,  // ← 必須
});

// cache lookup
await supabase.from('assets')
  .select('*')
  .eq('cache_key', cacheKey)
  .eq('created_by', ctx.userId)  // ← 必須
  .maybeSingle();
```

これがないと user A のキャッシュが user B に漏れる。コードレビューで必ず確認。

## 9. `.vscode/mcp.json` (HTTP 版)

```jsonc
{
  "servers": {
    "figma-internal": {
      "type": "http",
      "url": "https://figma-mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:FIGMA_MCP_TOKEN}"
      }
    }
  }
}
```

**変更点**:
- `type` が `stdio` から `http` に
- `command` / `args` / 個別 env が消える
- `headers` でトークンを渡す
- `FIGMA_MCP_TOKEN` は OS 環境変数 / Codespaces secret / `.env` 由来

開発者は `FIGMA_MCP_TOKEN` だけ持っていれば動く。Supabase URL や Figma PAT は必要ない。

## 10. デプロイ

### 10.1 Fly.io への merge デプロイ

`packages/figma-mcp-service/Dockerfile` (renderer-worker のものを流用):

```dockerfile
FROM mcr.microsoft.com/playwright:v1.49.0-jammy
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/figma-mcp-service/package.json packages/figma-mcp-service/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/figma-mcp-service packages/figma-mcp-service
RUN pnpm --filter @figma-mcp-poc/shared build
RUN pnpm --filter figma-mcp-service build
EXPOSE 3000
CMD ["node", "packages/figma-mcp-service/dist/server.js"]
```

`fly.toml`:
```toml
app = "figma-mcp-service"
primary_region = "nrt"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  min_machines_running = 1

[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1
```

`auto_stop_machines = false` 推奨 (cold start するとブラウザ初期化に数十秒かかる)。

### 10.2 シークレット注入

```bash
fly secrets set \
  SUPABASE_URL="https://xxx.supabase.co" \
  SUPABASE_ANON_KEY="eyJ..." \
  SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
  FIGMA_TOKEN="figd_..." \
  FIGMA_STATE_JSON="$(cat .playwright-state/figma.json | base64 -w0)" \
  LOG_LEVEL="info"
```

worker 起動時に `FIGMA_STATE_JSON` を decode して一時ファイル化 (Phase 3 で実装済みのロジックを流用)。

### 10.3 カスタムドメイン (オプション)

```bash
fly certs create figma-mcp.internal.example.com
# DNS の CNAME を Fly.io の指示に従って設定
```

### 10.4 ヘルスチェック

```toml
[[http_service.checks]]
  interval = "30s"
  timeout = "5s"
  grace_period = "60s"
  method = "GET"
  path = "/healthz"
```

## 11. Codespaces セットアップ

### 11.1 Codespaces secret 登録

Repository 設定 → Codespaces → Secrets で:
- `FIGMA_MCP_TOKEN` ... API key (例: `fmps_xxxxx`)

これだけ。Supabase キーや Figma PAT は登録不要。

### 11.2 devcontainer.json (オプション)

```jsonc
{
  "name": "figma-mcp-poc-client",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:20",
  "customizations": {
    "vscode": {
      "extensions": [
        "github.copilot",
        "github.copilot-chat"
      ]
    }
  },
  "secrets": {
    "FIGMA_MCP_TOKEN": {
      "description": "Token for figma-mcp.example.com",
      "documentationUrl": "https://internal-wiki/.../figma-mcp"
    }
  }
}
```

これで Codespaces 立ち上げ時に Copilot 拡張が入り、`FIGMA_MCP_TOKEN` が環境変数として渡る。`.vscode/mcp.json` がそれを参照して MCP 接続できる。

### 11.3 ローカル VS Code

`.env` (ローカル) に `FIGMA_MCP_TOKEN=fmps_xxx` を書いて、シェル起動時に export。または OS のキーチェーンに登録。

## 12. ロギング

stdio 制約から解放されたので、サーバー側で構造化ログを取れる:

```ts
// src/lib/logger.ts (改修)
export function logRequest(ctx: {
  userId: string;
  toolName: string;
  fileKey: string;
  nodeId: string;
  cacheHit: boolean;
  durationMs: number;
}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...ctx }));
}
```

Fly.io の `fly logs` で集約・grep 可能。本番では SIEM 連携を視野。

## 13. 動作確認

### 13.1 curl での疎通テスト

```bash
TOKEN=fmps_xxxxx
curl -X POST https://figma-mcp.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- [ ] レスポンスに `figma_get_screenshot` と `figma_get_node_info` が含まれる
- [ ] `Mcp-Session-Id` ヘッダがレスポンスに付く

### 13.2 VS Code (ローカル) 連携テスト

`.vscode/mcp.json` を HTTP 版に書き換え → VS Code 再起動 → Copilot Chat (Agent) で Figma URL ペースト → 画像表示。Phase 5 と同じ確認。

### 13.3 Codespaces 連携テスト

Codespaces を新規起動 → `FIGMA_MCP_TOKEN` が secret で渡っていることを確認 → Copilot Chat (Agent) で URL ペースト → 画像表示。

**ポイント**: Codespaces コンテナには mcp-server のコードも .env も何もない。`.vscode/mcp.json` (リポジトリ内) と secret の token だけで完結する。これが remote MCP のメリット。

## 14. 移行手順 (stdio → remote)

PoC が動いている状態からの段階的移行:

1. `packages/renderer-worker` を `packages/figma-mcp-service` にリネーム (git mv)
2. ツール定義 (`get-screenshot.ts`, `get-node-info.ts`) を mcp-server から service に移植
   - HTTP 経由の worker 呼び出しを直接関数呼び出しに変更
3. `@modelcontextprotocol/sdk` を service の dependencies に追加
4. `src/mcp/index.ts`, `src/mcp/transport.ts` を新規作成
5. `src/routes/mcp.ts` を実装し `server.ts` でマウント
6. `src/routes/render.ts` `node-info.ts` を削除（または `internal-debug` ルートとして残してデバッグ用に）
7. `packages/mcp-server` を削除（git rm -r）
8. `scripts/get-token.ts` または `scripts/issue-api-key.ts` を実装
9. `.vscode/mcp.json` を HTTP 版に書き換え
10. ローカルで `pnpm dev` 起動 → curl で疎通 → VS Code で動作確認
11. Fly.io にデプロイ → リモートからの動作確認
12. Codespaces で動作確認

各ステップで [ACCEPTANCE_TESTS.md §Phase 7](../ACCEPTANCE_TESTS.md#phase-7-remote-mcp-化) を満たすことを確認。

## 15. トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| VS Code が "type:http" を認識しない | VS Code を 1.102 以降に更新 |
| 401 Unauthorized | `FIGMA_MCP_TOKEN` 期限切れ → 再発行 |
| Mcp-Session-Id が毎リクエスト変わる | session map がプロセス間で共有されていない (Fly.io で複数 machines だと起きる)。`min_machines_running = 1` & `max_machines_running = 1` 推奨 |
| Codespaces で接続失敗 | secret 未設定 / リポジトリスコープ確認、`echo $FIGMA_MCP_TOKEN` で確認 |
| SSE タイムアウト | Fly.io / プロキシの idle timeout 設定確認 |
| 別ユーザーのキャッシュが見える | `created_by` フィルタが抜けている。コード grep で全 select 文を再確認 |

## 16. PoC 範囲外 (本番設計で対応)

- OAuth 2.0 Authorization Code Flow (Device Flow)
- IdP federation (Okta / Azure AD)
- API key の自動ローテーション
- Rate limit per user / per file_key
- 複数 machines への scale-out (session affinity 必要)
- WAF / DDoS 対策
