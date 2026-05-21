# figma-mcp-poc

社内ガバナンス上、Figma 公式 MCP（`/v1/images` が公開 S3 に画像を生成する経路）が使えない環境向けの、**公開 S3 を一切経由しない** Figma MCP の PoC 実装。

VS Code Copilot Chat (Agent) に Figma URL をペーストすると、サービスが Playwright で Figma Web をレンダリングして Supabase Storage に PNG を保存し、署名付き URL 経由で AI に画像を渡す。

詳細仕様: [docs/](./docs/) (README → ARCHITECTURE → IMPLEMENTATION_PLAN → CLAUDE → specs/ → reference/ の順で読むのを推奨)

---

## 構成

| パッケージ | 内容 |
|---|---|
| `packages/shared` | API 契約 / DB 行の TS 型 |
| `packages/figma-mcp-service` | Hono + Playwright + MCP (HTTP/SSE) を 1 サービスに統合 |

実行形態は **リモート HTTP MCP** (Phase 7) を主とする。VS Code は `.vscode/mcp.json` から `http://localhost:3000/mcp` (ローカル開発) または `https://<fly-app>.fly.dev/mcp` (本番) に Bearer Token で接続する。

---

## 5 分セットアップ (ローカル開発)

### 前提

- Node.js 20 以上 (推奨 22)
- pnpm 9+ (なければ `corepack enable pnpm`)
- Supabase アカウント（Free プラン可）
- Figma 個人アカウント
- macOS / Linux

### 手順

```bash
# 1. 依存インストール
pnpm install

# 2. .env を作る
cp .env.example .env
# .env を編集して各値を埋める (詳細は docs/reference/env-vars.md)

# 3. Supabase の準備 (Dashboard 手動 + migration)
#    docs/specs/supabase-spec.md §4 の手順に従う
supabase db push

# 4. Playwright chromium を入れる
pnpm --filter figma-mcp-service exec playwright install chromium

# 5. Figma に手動ログイン (ブラウザが開く → ログイン後 Enter)
pnpm login-figma

# 6. サービス起動
pnpm dev
# → http://localhost:3000 で待ち受け開始 ( /mcp, /healthz, /internal-debug/* )

# 7. API Key 発行 (= FIGMA_MCP_TOKEN)
pnpm get-token        # 開発初期: 1 時間有効な JWT
# または
pnpm issue-api-key --user <auth.users.id> --label "local-dev"   # 長寿命 fmps_xxx

# 8. .env に FIGMA_MCP_TOKEN=<上記出力> を追記し、シェルを再ロード or
#    export FIGMA_MCP_TOKEN=...

# 9. VS Code で本ディレクトリを開く
#    .vscode/mcp.json (type: http) が読まれて MCP に接続される
#    Copilot Chat → Agent モード → Figma URL ペースト → 画像表示
```

`.env` の各変数は [docs/reference/env-vars.md](./docs/reference/env-vars.md) を参照。

---

## 動作確認 (curl)

```bash
# ヘルスチェック
curl http://localhost:3000/healthz

# tools/list
TOKEN=$FIGMA_MCP_TOKEN
curl -sX POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

詳細チェックリスト: [docs/ACCEPTANCE_TESTS.md](./docs/ACCEPTANCE_TESTS.md) §Phase 7

---

## Fly.io デプロイ (本番)

```bash
cd packages/figma-mcp-service
fly launch --no-deploy             # fly.toml がすでにあるので確認のみ
fly secrets set \
  SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  FIGMA_TOKEN="$FIGMA_TOKEN" \
  FIGMA_STATE_JSON="$(base64 < ../../.playwright-state/figma.json)"
fly deploy
```

デプロイ後、`.vscode/mcp.json` の `url` を `https://<your-app>.fly.dev/mcp` に変更 (`.vscode/mcp.production.json.example` 参照)。

---

## Codespaces

- リポジトリ Settings → Codespaces → Secrets で **`FIGMA_MCP_TOKEN` のみ** 登録
- Codespaces 起動 → `.devcontainer/devcontainer.json` が Copilot 拡張をインストール
- `.vscode/mcp.json` が読まれて MCP に接続 → Figma URL ペーストで動作

Codespaces 内に `.env` も Supabase キーも Figma PAT も存在しない。これが Phase 7 の核心。

---

## トラブルシュート

| 症状 | 対処 |
|---|---|
| `pnpm login-figma` でブラウザが開かない | `pnpm --filter figma-mcp-service exec playwright install chromium` を再実行 |
| `/mcp` が 401 | `FIGMA_MCP_TOKEN` の値、期限切れ確認 (JWT なら 1 時間) |
| `/internal-debug/render` が 422 `figma_unauthenticated` | `.playwright-state/figma.json` 期限切れ → `pnpm login-figma` 再実行 |
| 504 `playwright_timeout` | ネットワーク or Figma UI セレクタ変更。`docs/specs/renderer-worker-spec.md` を確認 |
| VS Code が MCP を認識しない | VS Code を 1.102 以降に更新、`.vscode/mcp.json` の root key が `"servers"` か確認 |
| Copilot Chat にツールが出ない | Agent モードか、Configure Tools で `figma_get_screenshot` が ON か確認 |

---

## やってはいけないこと

- `/v1/images` を使う経路を実装する (公開 S3 にデータが乗る)
- 認証情報・トークンをログ・コミットに含める
- `SUPABASE_SERVICE_ROLE_KEY` を dev 機 (VS Code 側) で扱う — Phase 7 ではサーバー側のみ
- `assets` / `audit_log` クエリで `created_by = userId` を抜かす (per-user 漏洩)

詳細は [docs/CLAUDE.md](./docs/CLAUDE.md) §「やってはいけないこと」。

---

## ライセンス

Internal PoC. Not for redistribution.
