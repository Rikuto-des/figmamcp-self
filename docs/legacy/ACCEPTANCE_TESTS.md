# ACCEPTANCE_TESTS — 受け入れテスト

各フェーズで「これが満たせたら次に進める」基準。Claude Code は実装後にここをチェックする。

すべて手動テスト。PoC のため自動 E2E は省略。

---

## Phase 0: プロジェクト初期化

### A0.1 リポジトリ構造
- [ ] `package.json` (root) に `"workspaces"` または `pnpm-workspace.yaml` に packages 宣言がある
- [ ] `packages/shared`, `packages/mcp-server`, `packages/renderer-worker` のディレクトリが存在
- [ ] `tsconfig.base.json` がルートにある
- [ ] `.gitignore` に少なくとも以下が含まれる:
  - `node_modules/`
  - `dist/`
  - `.env`
  - `.env.local`
  - `.playwright-state/`
  - `*.log`

### A0.2 ビルド可能
```bash
pnpm install
pnpm -r build
```
- [ ] エラーなく完了する（空パッケージでも tsc が走れば OK）

---

## Phase 1: Supabase

### A1.1 プロジェクト構築
- [ ] Supabase ダッシュボードでプロジェクトが見える
- [ ] Project URL と anon / service_role キーがメモされている
- [ ] `.env` に値が入っている

### A1.2 DB スキーマ
ダッシュボード Table Editor で確認:
- [ ] `public.assets` テーブルが存在し、カラムが [supabase-spec.md §2.1](./specs/supabase-spec.md) と一致
- [ ] `public.audit_log` テーブルが存在し、カラムが §2.2 と一致
- [ ] `assets.cache_key` に unique 制約がある (created_by との複合)
- [ ] RLS が両テーブルで有効
- [ ] ポリシー `own assets read`, `own audit read` が存在
- [ ] `public.delete_expired_assets()` 関数が存在

### A1.3 Storage
- [ ] バケット `figma-assets` が存在
- [ ] Public = OFF
- [ ] File size limit が 50 MB
- [ ] `storage.objects` に `own files select` ポリシーが存在

### A1.4 Auth
- [ ] 1 ユーザー (POC_EMAIL) が作成済み
- [ ] そのユーザーで Supabase Auth API にログインできる（curl 確認）:
  ```bash
  curl -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$POC_EMAIL\",\"password\":\"$POC_PASSWORD\"}"
  ```
  → `access_token` が返ってくる

---

## Phase 2: 共有型定義

### A2.1 型エクスポート
- [ ] `packages/shared/dist/` が生成されている
- [ ] `packages/shared/dist/index.d.ts` に `RenderRequest`, `RenderResponse`, `NodeInfoResponse`, `Asset` 等が定義されている

### A2.2 他パッケージから import 可能
他パッケージで次のように書けることを確認:
```ts
import type { RenderRequest } from '@figma-mcp-poc/shared';
```
- [ ] tsc がエラーを出さない

---

## Phase 3: Renderer Worker

### A3.0 事前準備
- [ ] `pnpm exec playwright install chromium` 実行済み
- [ ] `pnpm login-figma` を実行して `.playwright-state/figma.json` が生成済み
- [ ] `.env` の `FIGMA_TOKEN` に有効な PAT が入っている

### A3.1 起動
```bash
pnpm dev:worker
```
- [ ] worker がエラーなく起動し、ポート 3000 で待ち受ける旨のログが出る

### A3.2 healthz
```bash
curl http://localhost:3000/healthz
```
- [ ] 200 が返る
- [ ] `{ "status": "ok", "browser_ready": true, ... }`

### A3.3 認証なしリクエスト
```bash
curl -X POST http://localhost:3000/render \
  -H "Content-Type: application/json" \
  -d '{"figma_url":"https://www.figma.com/design/abc/x?node-id=1-23"}'
```
- [ ] 401 が返る

### A3.4 URL パース失敗
```bash
TOKEN=<get from Phase 1.4 curl>
curl -X POST http://localhost:3000/render \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"figma_url":"not-a-figma-url"}'
```
- [ ] 400 が返る

### A3.5 正常レンダリング (Figma sandbox file 使用)
事前に個人 Figma で作ったテストファイルの URL を使う:
```bash
curl -X POST http://localhost:3000/render \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"figma_url":"https://www.figma.com/design/<file_key>/Test?node-id=1-2","scale":2}'
```
- [ ] 200 が返る
- [ ] `asset_id`, `signed_url`, `cache_hit: false`, `rendered_via: "playwright"` が含まれる
- [ ] `curl <signed_url>` で実際に PNG ファイルが取得できる
- [ ] PNG を開いてノードが実際に描画されている

### A3.6 キャッシュ動作
A3.5 と同じリクエストをもう一度実行:
- [ ] 2 回目のレスポンスで `cache_hit: true`, `rendered_via: "cache"`
- [ ] 1 回目より明らかに早い

### A3.7 force_refresh
```bash
curl -X POST http://localhost:3000/render \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"figma_url":"...","force_refresh":true}'
```
- [ ] `cache_hit: false`, `rendered_via: "playwright"` で新規 asset が生成される

### A3.8 node-info
```bash
curl -X POST http://localhost:3000/node-info \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"figma_url":"https://www.figma.com/design/<file_key>/Test?node-id=1-2"}'
```
- [ ] 200 が返り、`node.name`, `node.type`, `node.absoluteBoundingBox` が含まれる

### A3.9 DB / Storage 反映
Supabase Dashboard で確認:
- [ ] `assets` テーブルに A3.5 と A3.7 の 2 行が追加されている
- [ ] `audit_log` に `render.requested`, `render.completed`, `asset.download_url_issued`, `render.cache_hit` 等のイベントが時系列で記録されている
- [ ] Storage `figma-assets` バケットに `<user_id>/<file_key>/.../<sha256>.png` が存在

### A3.10 単体テスト
```bash
pnpm --filter renderer-worker test
```
- [ ] `url-parser.test.ts` が全て pass

---

## Phase 4: MCP Server

### A4.1 ビルド
```bash
pnpm --filter mcp-server build
```
- [ ] エラーなし
- [ ] `bin/mcp-server.js` が実行可能 (`chmod +x`)

### A4.2 tools/list
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  pnpm --filter mcp-server tsx src/server.ts 2>/dev/null
```
- [ ] JSON 応答に `figma_get_screenshot` と `figma_get_node_info` のスキーマが含まれる
- [ ] stdout が JSON-RPC で汚染されていない（ログが stdout に出ていない）

### A4.3 ログイン
- [ ] `~/.config/figma-mcp-poc/session.json` が初回ツール呼び出し後に生成される
- [ ] ファイル権限が `0600`

### A4.4 stdout 汚染チェック
`src/` 配下を grep:
```bash
grep -rn "console\.log" packages/mcp-server/src/
```
- [ ] 結果が空。`console.log` は1箇所も使っていない

---

## Phase 5: VS Code 統合

### A5.1 MCP サーバー認識
- [ ] VS Code を開くと `.vscode/mcp.json` の存在を検知して MCP server を起動するか聞かれる
- [ ] Start を選んで起動が成功する
- [ ] MCP: List Servers コマンドで `figma-internal` が「Running」状態

### A5.2 ツール表示
Copilot Chat を開いて:
- [ ] モードを「Agent」に切り替える
- [ ] チャット入力欄左の Configure Tools ボタンに `figma_get_screenshot` と `figma_get_node_info` が出る
- [ ] 両方が ON になっている

### A5.3 URL ペースト動作
worker をローカル起動 (`pnpm dev:worker`) した状態で:
- [ ] Copilot Chat に Figma URL を貼って「これスクショして」と日本語で入力
- [ ] ツール実行確認ダイアログが出る
- [ ] Allow を押すと数秒〜十数秒で画像がチャットに表示される
- [ ] 画像が実際の Figma ノードと視覚的に一致

### A5.4 URL → コード生成 (UX 確認)
- [ ] 「この Figma 画面の React コンポーネントを書いて [URL]」と入力
- [ ] Copilot が画像と node_info を取得して、画像内容に基づいた React コードを生成
- [ ] 生成されたコードがおおむね妥当（要素の構造、色、テキストが反映）

### A5.5 ログ確認
- [ ] `tail -f /tmp/figma-mcp-poc.log` で MCP server のログが流れる
- [ ] worker 側のターミナルでもリクエストログが流れる

---

## Phase 6: 仕上げ

### A6.1 README
- [ ] ルート README.md に「5分セットアップ」相当の手順がある
- [ ] 必要前提（Node 20+, pnpm, Supabase, Figma 個人アカウント）が明記
- [ ] トラブルシュート節がある

### A6.2 Docker / Fly.io (任意)
- [ ] `packages/renderer-worker/Dockerfile` が存在し `docker build` が成功
- [ ] `fly deploy` で Fly.io にデプロイ可能（オプション）
- [ ] デプロイ後 `WORKER_URL` を Fly.io URL に変えても A5.3 が動く

### A6.3 Tier C 脅威確認
```bash
# scripts/demo-tier-c-leak.sh の出力
```
- [ ] `/v1/images` で得た URL が、Authorization なしで curl して 200 + PNG bytes が返る
- [ ] スクリーンショット or ログを保存（ガバナンス審査エビデンス）

### A6.4 機密度別 TTL (オプション)
- [ ] classification=confidential で取った signed URL が約 5 分後に 403 になる
- [ ] classification=internal で取った signed URL が約 15 分後に 403 になる

---

## Phase 7: リモート MCP 化

### A7.1 パッケージ統合
- [ ] `packages/figma-mcp-service/` が存在 (renderer-worker から rename)
- [ ] `packages/mcp-server/` が削除されている
- [ ] `git log --diff-filter=R` でリネーム履歴が確認できる
- [ ] `src/mcp/tools/get-screenshot.ts`, `src/mcp/tools/get-node-info.ts` が存在

### A7.2 ビルド
```bash
pnpm install
pnpm -r build
```
- [ ] エラーなく完了
- [ ] `packages/figma-mcp-service/dist/server.js` が生成される
- [ ] `@modelcontextprotocol/sdk` が dependencies に入っている

### A7.3 API Key 発行
- [ ] migration で `public.api_keys` テーブルが作成されている
- [ ] `pnpm tsx scripts/issue-api-key.ts --user <id> --label "test"` で `fmps_` 始まりのキーが標準出力に1回だけ表示される
- [ ] DB の `key_hash` に元キーがそのまま入っていない (hash 化されている)

### A7.4 ローカル起動 + 疎通
```bash
pnpm dev   # figma-mcp-service が localhost:3000 で起動
```
- [ ] `GET /healthz` が 200
- [ ] `Authorization` なしの `POST /mcp` が 401
- [ ] 不正な Bearer の `POST /mcp` が 401

### A7.5 tools/list (HTTP 経由)
```bash
TOKEN=fmps_xxxxx
curl -sX POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
- [ ] レスポンスに `figma_get_screenshot` と `figma_get_node_info` が含まれる
- [ ] `Mcp-Session-Id` ヘッダがレスポンスに付く

### A7.6 tools/call (HTTP 経由)
```bash
curl -sX POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: <前のレスポンスのID>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"figma_get_screenshot","arguments":{"figma_url":"https://www.figma.com/design/<file_key>/Test?node-id=1-2"}}}'
```
- [ ] 200 が返り、image content (base64) と text content が含まれる
- [ ] base64 をデコードした PNG が実際の Figma ノードと一致

### A7.7 per-user 分離
2 ユーザー (A, B) で別の API Key を発行:
- [ ] A のキーで render → asset 作成
- [ ] B のキーで同じ URL に対して render → A の cache が**引かれず** 新しい asset が生成される
- [ ] Supabase ダッシュボードで A と B の `assets.created_by` が異なる

### A7.8 ロギング
- [ ] `fly logs` (or local の stdout) に 1 行 JSON で `{ts, userId, toolName, fileKey, ...}` が出る
- [ ] `MCP_LOG_FILE` 関連コードが残っていない (grep で空)
- [ ] mcp-server 旧コードの `token-store.ts` などが残っていない

### A7.9 VS Code 連携 (HTTP transport, local)
`.vscode/mcp.json` を HTTP 版に書き換え (url=localhost:3000/mcp, Authorization ヘッダで FIGMA_MCP_TOKEN):
- [ ] VS Code が `type:"http"` で接続する
- [ ] Copilot Chat (Agent) で Figma URL ペースト → 画像表示
- [ ] Phase 5 と同じ end-to-end が動く

### A7.10 Fly.io デプロイ
- [ ] `fly deploy` 成功
- [ ] `fly secrets list` に SUPABASE_*, FIGMA_TOKEN, FIGMA_STATE_JSON が含まれる
- [ ] `curl -X GET https://<app>.fly.dev/healthz` が 200
- [ ] `.vscode/mcp.json` の url を本番に書き換えて A7.9 を再実施 → 動作

### A7.11 Codespaces 動作
- [ ] Repository → Settings → Codespaces → Secrets で `FIGMA_MCP_TOKEN` を登録
- [ ] 新規 Codespaces を起動
- [ ] Codespaces 内のシェルで `echo $FIGMA_MCP_TOKEN` が値を返す
- [ ] Codespaces 内に `.env` ファイルが**作られていない** (git でも作らない)
- [ ] Codespaces 内に `packages/mcp-server/` も `.playwright-state/` も存在しない
- [ ] Codespaces の VS Code で Copilot Chat (Agent) を開いて Figma URL ペースト → 画像表示

### A7.12 credentials が dev 機にないことの確認
ローカル VS Code で:
- [ ] `.env` から `SUPABASE_SERVICE_ROLE_KEY` と `FIGMA_TOKEN` と `POC_PASSWORD` を削除
- [ ] `FIGMA_MCP_TOKEN` だけ残す
- [ ] それでも MCP 経由で画像取得が動く
- [ ] (`.playwright-state/figma.json` もローカルから削除して同様に動くことを確認)

これが Phase 7 の最大の価値: dev 機には **長寿命 API Key 1 つ** しか置かない。

---

## 全体的な確認項目

### G1. シークレット漏洩なし
- [ ] `.env` がコミットされていない (`git status` で確認)
- [ ] `.playwright-state/` がコミットされていない
- [ ] コード内に `figd_` や `eyJ` で始まる長い文字列リテラルがない (grep)

### G2. mcp-server から service_role が見えない
Phase 4〜6 (stdio 期):
```bash
grep -rn "SERVICE_ROLE" packages/mcp-server/
```
- [ ] 結果が空

Phase 7 以降 (リモート期、`packages/mcp-server/` は削除済み):
- [ ] そもそも mcp-server パッケージが存在しない
- [ ] `figma-mcp-service` は service_role を持っていてよい (サーバー側だから)
- [ ] `.vscode/mcp.json` に SERVICE_ROLE 等が現れない

### G3. `/v1/images` 不使用
```bash
grep -rn "/v1/images" packages/ scripts/
```
- [ ] 結果が空（Tier C 確認スクリプト `scripts/demo-tier-c-leak.sh` を除く）

### G4. 操作の単純さ
- [ ] 開発者の操作: 「URL コピー → チャットに貼る → 質問」の3ステップで完結
- [ ] それ以外の手作業が要らない（初回セットアップ後）

---

## 不合格時の対処

| Phase | 不合格項目 | 確認 |
|---|---|---|
| Phase 1 | A1.4 ログイン失敗 | email 認証が必要な設定になっていないか、ダッシュボードで Confirm を実行 |
| Phase 3 | A3.5 で `figma_unauthenticated` | `pnpm login-figma` を再実行 |
| Phase 3 | A3.5 で画像が真っ白 | Playwright 待機時間を増やす、Figma UI セレクタ更新 |
| Phase 3 | A3.5 で 500 | worker ログを確認、Supabase 接続情報・キー間違い疑い |
| Phase 4 | A4.2 で JSON が壊れる | `console.log` を grep で再確認 |
| Phase 5 | A5.3 で画像が表示されない | ファイルサイズが大きすぎないか (5MB目安)、Copilot Chat 設定で画像入力可能か |
| Phase 5 | A5.3 でツールが呼ばれない | tool description を見直す、または「@figma-internal でスクショして」と明示呼び出し |
| Phase 7 | A7.5 で 404 | path が `/mcp` か確認、Hono の route mount を確認 |
| Phase 7 | A7.6 で session 関連エラー | `Mcp-Session-Id` を A7.5 のレスポンスから取得して再送、session map が initialize していない可能性 |
| Phase 7 | A7.9 で VS Code が接続失敗 | VS Code 1.102+ か確認、`type:"http"` が認識されない古いバージョンの可能性 |
| Phase 7 | A7.11 で Codespaces から接続できない | `FIGMA_MCP_TOKEN` 未設定、または Fly.io app の URL がプライベートになっている (allow_concurrent_connections / network ACL 確認) |
| Phase 7 | A7.7 で B が A の cache を引いてしまう | `created_by` フィルタ漏れ。`packages/figma-mcp-service/src/` で `supabase.from('assets')` を全部 grep して `.eq('created_by', ...)` の有無を確認 |
