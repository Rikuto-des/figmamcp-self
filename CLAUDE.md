# CLAUDE.md (Root)

このリポジトリで作業する Claude Code 向けの簡易ガイド。

## ディレクトリ構成

```
.
├── README.md                  # ユーザ向けセットアップ
├── CLAUDE.md                  # ← ここ
├── docs/
│   ├── explainer.html         # 中高生向け解説（自作前後の比較）
│   ├── lt-slides.html         # 社外向け LT スライド
│   └── ...                    # 旧仕様書（履歴的に参照）
├── packages/
│   ├── shared/                # @figma-mcp-poc/shared (型のみ)
│   └── figma-mcp/             # stdio MCP server + Playwright (一体)
│       ├── src/
│       │   ├── server.ts            # stdio エントリ
│       │   ├── render.ts            # Playwright で Figma を撮る本体
│       │   ├── cache.ts             # in-memory LRU
│       │   ├── figma-rest.ts        # /v1/files/.../nodes (JSON のみ)
│       │   ├── env.ts / logger.ts / url-parser.ts
│       │   └── mcp/
│       │       ├── index.ts
│       │       └── tools/
│       │           ├── get-screenshot.ts
│       │           └── get-node-info.ts
│       └── scripts/
│           ├── login-figma.ts       # Figma 対話ログイン (永続)
│           └── test-render-once.ts  # 単発レンダ確認
├── .vscode/mcp.json           # stdio で packages/figma-mcp/dist/server.js を起動
└── .devcontainer/             # Codespaces 用
```

## 主要コマンド

```bash
pnpm install                                                # 依存
pnpm --filter figma-mcp exec playwright install chromium    # 初回のみ
pnpm login-figma                                            # Figma 対話ログイン
pnpm -r build                                               # 全ビルド
pnpm dev                                                    # tsx でローカル起動 (デバッグ用)
pnpm test                                                   # vitest (url-parser)
```

## 絶対のルール

- **`/v1/images` を呼ぶ実装を作らない**（公開 S3 漏洩経路 — このプロジェクトの存在理由）
- **`console.log` を server コードで使わない**（stdout は MCP JSON-RPC 専用）
  - ログは `logger.ts` 経由 → stderr へ
- 認証情報・トークンをログ/コミットに含めない
- `.env`、`.playwright-state/` は .gitignore 済み（コミット禁止）

## アーキテクチャ要点（v1.0 = embedded mode）

- **stdio** MCP server。HTTP/SSE は無い
- **シングルプロセス**。Supabase / Fly.io / 認証 / API キー は撤去済み
- 画像は **Codespaces のメモリの中だけ**。外向き URL は一切作らない
- キャッシュは **in-memory LRU**（最大 50 件、TTL 15 分）
- Figma ログインは **Playwright `storageState` + persistent profile**

## 旧アーキテクチャ（撤去済み）

過去のリビジョンでは Hono HTTP + Supabase Storage + Fly.io デプロイ + 独自 API キー（fmps_）まで持っていました。1 ユーザーの Codespaces 完結で要件を満たせるため、Phase 7 → v1.0 で全部撤去。詳細は git 履歴。
