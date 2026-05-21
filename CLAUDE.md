# CLAUDE.md (Root)

このリポジトリで作業する Claude Code 向けの簡易ガイド。**詳細は [docs/CLAUDE.md](./docs/CLAUDE.md) を必ず読むこと**。

## ディレクトリ構成 (Phase 7 完了状態)

```
.
├── README.md                  # ユーザ向けセットアップ
├── CLAUDE.md                  # ← ここ (簡易)
├── docs/                      # 仕様書一式
│   ├── README.md / ARCHITECTURE.md / IMPLEMENTATION_PLAN.md / CLAUDE.md
│   ├── ACCEPTANCE_TESTS.md
│   ├── specs/                 # supabase, renderer-worker, mcp-server, api-contracts, remote-mcp
│   └── reference/             # figma-url-formats, figma-session-setup, env-vars
├── packages/
│   ├── shared/                # @figma-mcp-poc/shared (API 契約 / DB 型)
│   └── figma-mcp-service/     # Hono + Playwright + MCP (HTTP/SSE)
├── supabase/migrations/       # DB スキーマ (init + api_keys)
├── scripts/
│   ├── demo-tier-c-leak.sh    # /v1/images 公開 S3 漏洩確認
│   ├── get-token.ts           # Supabase JWT 取得 (短寿命)
│   └── issue-api-key.ts       # fmps_ 長寿命 API Key 発行
├── .vscode/mcp.json           # MCP (HTTP) クライアント設定
└── .devcontainer/devcontainer.json   # Codespaces 用 (Copilot + FIGMA_MCP_TOKEN secret)
```

## 主要コマンド

```bash
pnpm install
pnpm login-figma            # Figma 個人アカウントを Playwright で保存
pnpm dev                    # figma-mcp-service を localhost:3000 で起動
pnpm get-token              # 開発初期: Supabase JWT を出力
pnpm issue-api-key --user <id> --label "..."   # 長寿命 fmps_ API Key を発行
pnpm -r build               # 全パッケージビルド
pnpm test                   # vitest (url-parser, per-user isolation)
```

## 絶対のルール

- `/v1/images` を呼ぶ実装を作らない (公開 S3 流出経路)
- 認証情報・トークンをログ/コミットに含めない
- `assets` / `audit_log` クエリで `created_by = ctx.userId` を必ず明示
- mcp transport のセッション ID を別ユーザー間で共有しない (auth.ts でチェック済み)

完全な規約とフェーズごとの進め方は [docs/CLAUDE.md](./docs/CLAUDE.md) と [docs/IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md)。
