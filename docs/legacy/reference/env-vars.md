# 環境変数一覧

全パッケージ・スクリプトで参照する環境変数の一覧。`.env` (ルート) に記述し、各パッケージから `process.env` で参照する。

## 必須・任意フラグの意味

- ✅ 必須: 起動時に欠けると fatal
- 🟡 任意: デフォルトあり、または特定フェーズのみ必要
- 🔒 秘密: コミット禁止、ログ出力禁止

---

## Supabase 関連

| 変数名 | 必須 | 用途 | 値の形式 | 利用 package | 備考 |
|---|---|---|---|---|---|
| `SUPABASE_URL` | ✅ | Supabase Project URL | `https://xxx.supabase.co` | renderer-worker, mcp-server, figma-mcp-service | Phase 1 以降 |
| `SUPABASE_ANON_KEY` | ✅ | 匿名アクセス用 公開鍵 | `eyJhbGciOiJIUzI1NiIsInR...` | mcp-server (JWT 取得用) | client-side OK |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ 🔒 | RLS bypass の server 鍵 | `eyJhbGciOiJIUzI1NiIsInR...` | renderer-worker, figma-mcp-service | **mcp-server に渡さない** |
| `STORAGE_BUCKET` | 🟡 | Storage バケット名 | 文字列 (default `figma-assets`) | worker / service | |
| `SIGNED_URL_TTL_SEC` | 🟡 | 署名 URL 有効秒数 | 整数 (default `300`) | worker / service | 5 分 |

---

## 認証 (PoC 用個人アカウント)

| 変数名 | 必須 | 用途 | 値の形式 | 利用 package | 備考 |
|---|---|---|---|---|---|
| `POC_EMAIL` | ✅ 🔒 | Supabase Auth ログイン email | email | mcp-server | Phase 1 で作成したユーザー |
| `POC_PASSWORD` | ✅ 🔒 | 同 password | 文字列 | mcp-server | |

Phase 7 以降は `FIGMA_MCP_TOKEN` (API Key) に置換。

---

## Figma 関連

| 変数名 | 必須 | 用途 | 値の形式 | 利用 package | 備考 |
|---|---|---|---|---|---|
| `FIGMA_TOKEN` | ✅ 🔒 | Figma REST API 用 Personal Access Token | `figd_xxxxx` | renderer-worker, figma-mcp-service | https://www.figma.com/settings → Personal Access Tokens で発行 |
| `FIGMA_STATE_JSON` | 🟡 🔒 | Playwright storageState (本番デプロイ時) | base64 化 JSON | figma-mcp-service (Phase 6/7) | `.playwright-state/figma.json` を base64 化したもの。Fly.io secret 注入用 |

ローカル開発時は `.playwright-state/figma.json` ファイルを直接読むので `FIGMA_STATE_JSON` 不要。

---

## サービス間通信

| 変数名 | 必須 | 用途 | 値の形式 | 利用 package | 備考 |
|---|---|---|---|---|---|
| `WORKER_URL` | 🟡 | mcp-server から worker への接続先 | URL (default `http://localhost:3000`) | mcp-server (Phase 4-6 のみ) | Phase 7 では不要 |
| `PORT` | 🟡 | worker / service の listen port | 整数 (default `3000`) | renderer-worker, figma-mcp-service | |

---

## ロギング

| 変数名 | 必須 | 用途 | 値の形式 | 利用 package | 備考 |
|---|---|---|---|---|---|
| `MCP_LOG_FILE` | 🟡 | mcp-server のログ出力先 (stdio 制約回避) | ファイルパス | mcp-server (Phase 4-6) | 例: `/tmp/figma-mcp-poc.log` |
| `LOG_LEVEL` | 🟡 | ログレベル | `debug` / `info` / `warn` / `error` (default `info`) | 全 package | |

---

## Phase 7 (リモート MCP)

| 変数名 | 必須 | 用途 | 値の形式 | 利用 package | 備考 |
|---|---|---|---|---|---|
| `FIGMA_MCP_TOKEN` | ✅ 🔒 | リモート MCP サービスへの Bearer Token | `fmps_xxxxx` (API Key) または Supabase JWT | VS Code (`.vscode/mcp.json` 経由) | 開発者の手元にはこれ 1 つだけ置く |

---

## .env.example の対応

ルートの `.env.example` は本ファイルの「必須」項目をすべて含み、ダミー値で雛形を提供する。`.env` は `cp .env.example .env` で作って実値を埋める。

`.env` は `.gitignore` 済み。コミット禁止。

---

## Phase 別の必要変数まとめ

| Phase | 必須変数 |
|---|---|
| Phase 0 | (なし) |
| Phase 1 | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `POC_EMAIL`, `POC_PASSWORD` |
| Phase 2 | 上記同 |
| Phase 3 | 上記 + `FIGMA_TOKEN` |
| Phase 4 | 上記 + `WORKER_URL` (任意), `MCP_LOG_FILE` (任意) |
| Phase 5 | Phase 4 と同じ |
| Phase 6 | 上記 + `FIGMA_STATE_JSON` (Fly.io デプロイ時) |
| Phase 7 | dev 機: `FIGMA_MCP_TOKEN` のみ / サーバー: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FIGMA_TOKEN`, `FIGMA_STATE_JSON` |
