# IMPLEMENTATION_PLAN — 実装計画

Claude Code はこのドキュメントをトップレベルのタスクリストとして使う。フェーズは順序通りに進める。各フェーズの終わりで [ACCEPTANCE_TESTS.md](./ACCEPTANCE_TESTS.md) の該当チェックリストを満たすことを確認してから次に進む。

## 全体マイルストーン

- **Phase 0**: プロジェクト初期化（モノレポ骨格）
- **Phase 1**: Supabase セットアップ（クラウド側、人手）
- **Phase 2**: 共有型定義パッケージ
- **Phase 3**: Renderer Worker (Playwright + Figma Web)
- **Phase 4**: MCP Server (stdio transport)
- **Phase 5**: VS Code 統合テスト
- **Phase 6**: 仕上げ（ドキュメント、Fly.io デプロイ）
- **Phase 7**: リモート MCP 化 (HTTP transport、Codespaces 対応)

Phase 0〜6 を完了すれば PoC として動作する。Phase 7 はその上で「mcp-server をリモート HTTP サービス化して、開発者の手元に credentials を置かなくても済むようにする」発展ステップ。社内 dogfooding 開始前に Phase 7 まで実施することを推奨。

各フェーズは独立して動作確認できる単位に切ってある。

---

## Phase 0: プロジェクト初期化

### ゴール
モノレポ骨格を作り、pnpm + TypeScript + lint/format が動く状態にする。

### 作業
1. リポジトリルートに以下を作成:
   - `package.json` (pnpm workspaces 宣言)
   - `pnpm-workspace.yaml`
   - `tsconfig.base.json`
   - `.gitignore` (node_modules, dist, .env*, *.log, .auth/, .playwright-state/)
   - `.env.example` (env-vars.md を参照して全変数を書く)
   - `.editorconfig`
   - 空の `packages/shared/`, `packages/mcp-server/`, `packages/renderer-worker/` ディレクトリ

2. ルートに開発依存をインストール:
   ```bash
   pnpm add -D -w typescript tsx @types/node prettier
   ```

3. `tsconfig.base.json`:
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "strict": true,
       "esModuleInterop": true,
       "skipLibCheck": true,
       "resolveJsonModule": true,
       "declaration": true,
       "declarationMap": true,
       "sourceMap": true
     }
   }
   ```

4. `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - "packages/*"
   ```

5. ルート `package.json` の `scripts`:
   ```json
   {
     "scripts": {
       "build": "pnpm -r build",
       "dev:worker": "pnpm --filter renderer-worker dev",
       "dev:mcp": "pnpm --filter mcp-server dev",
       "test": "pnpm -r test",
       "format": "prettier --write ."
     }
   }
   ```

### 完了条件
- `pnpm install` がエラーなく完了する
- `pnpm -r build` が（空でも）通る

---

## Phase 1: Supabase セットアップ

### ゴール
クラウド側の Supabase プロジェクトを作成し、DB スキーマと Storage バケットを準備する。

> **注**: ここは人間の作業。Claude Code は `supabase/migrations/` の SQL を作成して `supabase db push` の手順を README に書く。実際のクラウド操作は人間が行う。

### 作業
1. **[Manual]** Supabase ダッシュボードでプロジェクト `figma-mcp-poc` を作成
2. **[Manual]** Supabase CLI をインストール、`supabase login`、`supabase link --project-ref XXXX`
3. **[Claude Code]** `supabase/migrations/20260520000000_init.sql` を作成（→ [supabase-spec.md](./specs/supabase-spec.md) のスキーマセクションをコピー）
4. **[Manual]** `supabase db push` で migration を適用
5. **[Manual]** ダッシュボードで:
   - Auth → ユーザー作成（自分の email + password）
   - Storage → bucket `figma-assets` を作成、Public OFF
   - Storage → File size limit 50 MB
6. **[Claude Code]** ルート `.env.example` を整備、`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `POC_EMAIL`, `POC_PASSWORD`, `FIGMA_TOKEN` を含める
7. **[Manual]** `.env` を作成して値を埋める（gitignore 済み）

### 完了条件
- Supabase ダッシュボードで `assets`, `audit_log` テーブルが見える
- `figma-assets` バケットが見える
- 自分のアカウントでログイン可能

→ [supabase-spec.md](./specs/supabase-spec.md) 参照

---

## Phase 2: 共有型定義パッケージ

### ゴール
`packages/shared` に worker / mcp-server / DB の型を定義し、両パッケージから import できるようにする。

### 作業
1. `packages/shared/package.json` 作成 (`name: "@figma-mcp-poc/shared"`, `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`)
2. `packages/shared/tsconfig.json` (extends ../../tsconfig.base.json)
3. `packages/shared/src/api.ts` — Worker HTTP API の Request/Response 型を [api-contracts.md](./specs/api-contracts.md) から書き起こす
4. `packages/shared/src/db.ts` — `Asset`, `AuditLog` 型
5. `packages/shared/src/index.ts` で re-export
6. `pnpm -F @figma-mcp-poc/shared build` でビルド可能にする

### 完了条件
- `dist/` が生成される
- 他パッケージから `import type { RenderRequest } from "@figma-mcp-poc/shared"` できる

---

## Phase 3: Renderer Worker

### ゴール
HTTP API として動作する Playwright ベースのレンダラ。ローカルで `pnpm dev:worker` 起動 → `curl POST /render` で画像が取れるところまで。

### 3.1 サブフェーズ: Figma ログイン状態の永続化
- `scripts/login-figma.ts` を作成: Playwright で `headless: false` で Figma を開く → 人間がログイン → `storageState` を `.playwright-state/figma.json` に保存
- 1回実行すれば worker はこれを使ってログイン済み状態で起動できる
- → [reference/figma-session-setup.md](./reference/figma-session-setup.md)

### 3.2 サブフェーズ: HTTP サーバー骨格
- Hono を採用
- `src/server.ts`: ポート 3000 で起動、`GET /healthz`, `POST /render`, `POST /node-info`
- JWT 検証ミドルウェア (Authorization ヘッダ → Supabase に問い合わせ)

### 3.3 サブフェーズ: URL パース
- `src/url-parser.ts` を [reference/figma-url-formats.md](./reference/figma-url-formats.md) のテストケースに沿って実装
- 単体テスト `src/url-parser.test.ts` を作成、Vitest で実行

### 3.4 サブフェーズ: Figma REST クライアント
- `src/figma-rest.ts`: `getFileMeta(fileKey)` で `lastModified` を取得
- `FIGMA_TOKEN` (PAT) を使う

### 3.5 サブフェーズ: Playwright レンダリング本体
- `src/render.ts`:
  - シングルトンの browser context（storageState 使用）
  - `renderNode(figmaUrl): Promise<{ bytes, mimeType }>`
  - 詳細手順は [specs/renderer-worker-spec.md](./specs/renderer-worker-spec.md) の §4
- スクリーンショット最適化: canvas 領域だけ切り出す、不要 UI を CSS で隠す

### 3.6 サブフェーズ: Supabase クライアント
- `src/supabase.ts`: service_role キーで admin クライアントを作成
- `uploadAsset(userId, bytes, mimeType): Promise<{ path, digest }>`
- `findCached(cacheKey, userId)`, `insertAsset(...)`, `appendAuditLog(...)`

### 3.7 サブフェーズ: `/render` エンドポイント実装
- リクエスト受領 → JWT 検証 → URL パース → cache 確認 → 必要ならレンダリング → アップロード → DB 書き込み → signed URL 発行 → 返却
- エラーハンドリング（タイムアウト、Figma ログイン切れ、ノード見つからない等）

### 完了条件
- 別ターミナルで `curl -X POST http://localhost:3000/render -H 'Authorization: Bearer <jwt>' -d '{"figma_url":"https://..."}'` を実行
- レスポンスに `asset_id` と `signed_url` が含まれる
- signed URL を curl して PNG が取れる
- Supabase ダッシュボードで `assets` と `audit_log` に行が追加されている

→ [specs/renderer-worker-spec.md](./specs/renderer-worker-spec.md) 参照

---

## Phase 4: MCP Server

### ゴール
VS Code Copilot Chat から呼べる MCP サーバーを実装する。

### 4.1 サブフェーズ: MCP サーバー骨格
- `@modelcontextprotocol/sdk` を使用
- `src/server.ts`: stdio transport
- バージョン情報、`registerTool` の枠組み

### 4.2 サブフェーズ: Supabase Auth
- `src/auth.ts`: email/password でログイン、token を `~/.config/figma-mcp-poc/session.json` (mode 0600) に保存
- 期限切れなら refresh、`signInWithPassword` フォールバック
- 環境変数: `POC_EMAIL`, `POC_PASSWORD`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`

### 4.3 サブフェーズ: Worker クライアント
- `src/client.ts`: axios または fetch で worker を呼ぶ
- `WORKER_URL` 環境変数（既定 `http://localhost:3000`）
- リトライ・タイムアウト設定

### 4.4 サブフェーズ: ツール実装
- `src/tools/get-screenshot.ts`: figma_get_screenshot ツール
  - 入力: figma_url または file_key+node_id, format, scale
  - 内部で worker 呼び出し → signed URL から bytes ダウンロード → base64 化
  - 返却: image content block + text metadata block
- `src/tools/get-node-info.ts`: figma_get_node_info ツール
  - worker `/node-info` を呼ぶ
  - 構造化 JSON を返す

### 4.5 サブフェーズ: CLI エントリ
- `bin/mcp-server.js`: `#!/usr/bin/env node` で server.js を起動
- `package.json` の `bin` フィールド設定

### 完了条件
- `pnpm --filter mcp-server build` 成功
- 手動テスト: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/mcp-server.js` でツール一覧が返る

→ [specs/mcp-server-spec.md](./specs/mcp-server-spec.md) 参照

---

## Phase 5: VS Code 統合テスト

### ゴール
実際に VS Code Copilot Chat (Agent mode) からツールが呼ばれ、画像がチャットに表示される。

### 作業
1. プロジェクトルートの `.vscode/mcp.json` を作成 ([specs/mcp-server-spec.md](./specs/mcp-server-spec.md) §6 参照)
2. VS Code を再起動
3. worker をローカルで `pnpm dev:worker` 起動
4. VS Code で Copilot Chat を開く → Agent モード選択
5. テスト用 Figma URL をチャットに貼って「これスクショして」と入力
6. 確認ダイアログが出たら Allow
7. 画像が表示されればOK

### 完了条件
- [ACCEPTANCE_TESTS.md](./ACCEPTANCE_TESTS.md) §5 全項目を満たす

---

## Phase 6: 仕上げ

### ゴール
他人 (または将来の自分) がリポを clone して動かせる状態にする。

### 作業
1. リポジトリルートの README.md を実装視点で書き直す:
   - 5分で動かす手順
   - 必要な前提（Node 20+, pnpm, Supabase アカウント, Figma 個人アカウント）
   - `.env` の埋め方
   - `pnpm install && pnpm dev:worker` から始まる流れ
2. `packages/renderer-worker/Dockerfile` と `fly.toml` 作成（Playwright ベースイメージ使用）
3. (オプション) Fly.io にデプロイして remote worker でも動作確認
4. Tier C の脅威確認スクリプト `scripts/demo-tier-c-leak.sh` を作成:
   - 個人 Figma で `curl GET /v1/images` を叩く
   - 返ってきた URL を **認証ヘッダなし** で curl
   - 取れることを確認 → ガバナンス審査用エビデンスとしてスクリーンキャプチャ

### 完了条件
- 別ユーザーが README に沿って 30分以内に動かせる
- Tier C の脅威確認エビデンスが取れている

---

## Phase 7: リモート MCP 化

### ゴール
stdio MCP server を HTTP transport に書き換え、リモートサービスとして稼働させる。Codespaces / local VS Code 両方から同じ URL に接続し、credentials は開発者の手元に置かなくて済むようにする。

詳細スペックは [specs/remote-mcp-spec.md](./specs/remote-mcp-spec.md) を参照。Phase 6 完了が前提。

### 7.1 サブフェーズ: アーキテクチャ統合
- `packages/renderer-worker` を `packages/figma-mcp-service` にリネーム (git mv で履歴維持)
- `packages/mcp-server` から `tools/get-screenshot.ts`, `tools/get-node-info.ts` を `packages/figma-mcp-service/src/mcp/tools/` に移植
- ツール内部の HTTP worker 呼び出しを直接関数呼び出し (`renderForUser(...)`) に置換
- `@modelcontextprotocol/sdk` を service の dependencies に追加
- 旧 `packages/mcp-server` を削除 (`git rm -r`)

### 7.2 サブフェーズ: MCP transport (HTTP/SSE)
- `src/mcp/transport.ts` を新規作成、`StreamableHTTPServerTransport` を使う
- セッション管理 (`Mcp-Session-Id` ヘッダ → in-memory Map)
- `src/mcp/index.ts` で `buildMcpServer({ userId })` per-session 構築

### 7.3 サブフェーズ: POST /mcp ハンドラ
- `src/routes/mcp.ts` 新規
- GET /mcp (SSE notifications), DELETE /mcp (session close) も実装
- `server.ts` から mount
- 旧 `routes/render.ts`, `routes/node-info.ts` は削除（または `/internal-debug/*` に退避してデバッグ用に残す）

### 7.4 サブフェーズ: 認証 (Bearer Token + API Key)
- `src/auth.ts` の `requireBearer` を / `requireAuth` を拡張: Supabase JWT と独自 API Key の両方を受ける
- 独自 API Key 用のテーブル `public.api_keys` を migration に追加
  - [specs/remote-mcp-spec.md §8.3](./specs/remote-mcp-spec.md#83-トークン寿命と更新) の SQL
- `scripts/get-token.ts` (Supabase JWT 取得, 開発初期向け) と `scripts/issue-api-key.ts` (長寿命 API Key 発行, 運用向け) の両方を実装

### 7.5 サブフェーズ: per-user 分離の徹底
- すべての Supabase クエリ (assets select / insert, audit_log insert, storage upload path) で `created_by = ctx.userId` を明示
- コード grep で抜けがないか確認: `supabase.from('assets')` を全部 review
- ユニットテストで A ユーザーが B ユーザーの cache を引けないことを検証

### 7.6 サブフェーズ: ロギング改修
- stdio 制約がなくなったので `console.log` で構造化ログ OK
- userId, tool_name, file_key, node_id, cache_hit, duration_ms を 1 行 JSON で出力
- mcp-server 時代の token-store, MCP_LOG_FILE 関連コードは削除

### 7.7 サブフェーズ: `.vscode/mcp.json` 書き換え
```jsonc
{
  "servers": {
    "figma-internal": {
      "type": "http",
      "url": "https://figma-mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:FIGMA_MCP_TOKEN}" }
    }
  }
}
```
- ローカルテストでは `url` を `http://localhost:3000/mcp` に
- VS Code 1.102 以降が必要

### 7.8 サブフェーズ: Fly.io にデプロイ
- Dockerfile と fly.toml を service 用に整える ([specs/remote-mcp-spec.md §10](./specs/remote-mcp-spec.md#10-デプロイ))
- `min_machines_running = 1` (session affinity 確保のため当面 1 machine 限定)
- `fly secrets set` で SUPABASE_*, FIGMA_TOKEN, FIGMA_STATE_JSON を注入
- カスタムドメイン (オプション)

### 7.9 サブフェーズ: Codespaces 動作確認
- Repository Settings → Codespaces → Secrets で `FIGMA_MCP_TOKEN` を登録
- (オプション) `.devcontainer/devcontainer.json` を整備して Copilot 拡張を自動インストール
- 新規 Codespaces 起動 → Copilot Chat (Agent) → Figma URL ペースト → 画像表示確認
- **Codespaces 内に mcp-server コードも .env も存在しないことを確認** (これがリモート MCP の価値)

### 完了条件
- [ACCEPTANCE_TESTS.md §Phase 7](./ACCEPTANCE_TESTS.md#phase-7-リモート-mcp-化) 全項目を満たす
- ローカル VS Code、Codespaces どちらからも同じ URL で動作

---

## 注意事項

### Claude Code への一般指示
- **PoC スコープに留める**: KMS、Octa、CloudFront、Webhook、Tier A 等の本番要素は実装しない
- **個人アカウント前提**: 社内 SSO / Enterprise Figma の話は出さない
- **段階的に動作確認**: 各 Phase の Acceptance Tests を満たしてから次に進む
- **シークレットを絶対に commit しない**: `.env` は `.gitignore` 確認、Playwright `storageState` も同様
- **`console.log` を MCP server で使わない**: stdio が JSON-RPC で汚染される。デバッグは `console.error` (stderr) または専用ログファイル

### よく出るエラーと対処
- Playwright が起動しない → `npx playwright install chromium` を試す
- Supabase JWT 検証失敗 → SUPABASE_ANON_KEY と SERVICE_ROLE_KEY を取り違えていないか確認
- MCP サーバーが VS Code に認識されない → `.vscode/mcp.json` の root key が `"servers"` か確認 (mcpServers ではない)
- Figma ノードが表示されない → storageState が古い、login-figma.ts を再実行

### 開発の進め方の推奨
- 各 Phase で「動くもの」を最初に作って、後から品質を上げる
- Phase 3 (worker) は完成度を上げる前に Phase 4 (mcp-server) と繋いで end-to-end で動かしてみる
- ハマったら ACCEPTANCE_TESTS.md の該当項目から逆算して原因を絞る
