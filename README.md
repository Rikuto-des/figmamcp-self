# figma-mcp

社内で Figma 公式 MCP が使えない（`/v1/images` 経由で公開 S3 にデザインが乗るのが社内規定 NG）人向けの、自前 MCP サーバー。

**Codespaces 内で完結**。Supabase も Fly.io も認証基盤も不要。VS Code Copilot Chat (Agent) に Figma URL を貼ると、Playwright が同じプロセス内で Figma Web を撮影して PNG を返します。画像は一切外部に出ません。

```
Copilot Chat ──stdio──► 自作 MCP ──function call──► Playwright ──screenshot──► base64 ──► Copilot
                                                    (全部 Codespaces / ローカル内で完結)
```

## クイックスタート（ローカル）

```bash
# 1. 依存インストール + Playwright chromium
pnpm install
pnpm --filter figma-mcp exec playwright install chromium --with-deps

# 2. Figma に対話ログイン（一度だけ）
pnpm login-figma

# 3. ビルド
pnpm -r build

# 4. VS Code で本リポを開く（.vscode/mcp.json が stdio で MCP を起動）
code .
# Copilot Chat (Agent) を開いて Figma URL を貼り付け
```

## クイックスタート（GitHub Codespaces）

1. リポを Codespace で開く
2. `postCreateCommand` が自動で `pnpm install` → `playwright install` → `pnpm -r build` を実行
3. `pnpm login-figma` を一度だけ実行（Figma のログインを永続化）
4. Copilot Chat (Agent) → Figma URL ペースト → 完了

## 環境変数（だいたい不要）

`.env` は基本不要です。必要なものだけ、`.vscode/mcp.json` の `env` 欄か `.env` に書きます。

| 変数 | 用途 | 必須 |
|---|---|---|
| `FIGMA_STATE_PATH` | Playwright `storageState` JSON のパス | ❌（デフォルト有） |
| `FIGMA_PROFILE_DIR` | 永続 Chrome プロファイルのディレクトリ | ❌ |
| `FIGMA_STATE_JSON` | base64 化した storageState（Codespaces secret 用） | ❌ |
| `FIGMA_TOKEN` | Figma 個人アクセストークン | `figma_get_node_info` を使うときのみ |
| `LOG_LEVEL` | ログレベル (debug/info/warn/error) | ❌（既定 info） |

`figma_get_screenshot`（メインの撮影ツール）は何のトークンも要りません。

## MCP ツール

| ツール | 説明 | 必要 env |
|---|---|---|
| `figma_get_screenshot` | Figma の特定ノードを PNG で返す（Playwright 撮影 → base64）| なし |
| `figma_get_node_info` | Figma の特定ノードの JSON メタデータを返す | `FIGMA_TOKEN` |

## 何が無くなったか（v1.0 で削除）

過去には Supabase Storage / Postgres / Fly.io / Hono HTTP / 独自 API キー（fmps_）まで持っていましたが、**1 ユーザー前提の Codespaces 完結なら全部不要**と判断して撤去しました。詳しい経緯は `docs/explainer.html` を参照。

## ライセンス

PoC。コードはご自由にどうぞ。
