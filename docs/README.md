# Figma MCP PoC — 実装スペック

社内ガバナンス上、Figma 公式 MCP（`/v1/images` 経由で公開 S3 に画像を生成）が使えない環境で、**公開 S3 を一切経由せず**、Codespaces + VS Code + Copilot から「Figma URL ペースト → AI に画像が見える」UX を実現する社内代替実装の PoC スペック。

## このドキュメントセットの目的

Claude Code に与えて、ローカル/個人 SaaS で動く動作確認用 PoC を実装してもらうための完全な仕様書。社内 IdP、AWS KMS、CloudFront 等の本番ガバナンス要件は含まない（PoC スコープ外）。

## まず読む順番

1. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — システム全体の構成と設計判断
2. **[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)** — フェーズ分けされた実装計画（Claude Code はこれに沿って作業）
3. **[CLAUDE.md](./CLAUDE.md)** — リポジトリ規約、コマンド、コード規約
4. **specs/** — 各コンポーネントの詳細仕様
   - [supabase-spec.md](./specs/supabase-spec.md) — Supabase（DB / Storage / Auth / Edge Function）
   - [renderer-worker-spec.md](./specs/renderer-worker-spec.md) — Playwright ワーカー (Phase 3)
   - [mcp-server-spec.md](./specs/mcp-server-spec.md) — MCP サーバー (Phase 4, stdio版)
   - [api-contracts.md](./specs/api-contracts.md) — サービス間のAPI契約
   - [remote-mcp-spec.md](./specs/remote-mcp-spec.md) — リモート MCP 化 (Phase 7, HTTP版)
5. **reference/** — 細かい参照情報
   - [figma-url-formats.md](./reference/figma-url-formats.md) — URL パースの仕様
   - [figma-session-setup.md](./reference/figma-session-setup.md) — Playwright で Figma ログインを永続化する手順
   - [env-vars.md](./reference/env-vars.md) — 環境変数一覧
6. **[ACCEPTANCE_TESTS.md](./ACCEPTANCE_TESTS.md)** — 各フェーズの完了判定

## 達成したいUX

```
[Figma]                                          [VS Code + Copilot Chat]
  │                                                       │
  │ 右クリック → "Copy link to selection"                  │
  │ ↓                                                     │
  │ https://www.figma.com/design/abc/...?node-id=1-23     │
  │                                                       │
  └──────── Cmd+V でチャットに貼る ─────────────────────▶ │
                                                          │
                                  "この URL のコンポーネントを React で書いて"
                                                          │
                                  Copilot Agent が figma_get_screenshot 呼び出し
                                                          │
                                                          ▼
                                          画像 + コード生成結果が表示
```

開発者の操作は **URL コピー → ペースト → 質問** だけ。公式 Figma MCP と同じ操作感。

## 技術スタック（決定事項）

| レイヤ | 採用 | 理由 |
|---|---|---|
| 言語 | **TypeScript** 統一 | 全コンポーネントで型共有 |
| ランタイム | **Node.js 20+** (worker, mcp) / **Deno** (Edge Function) | Supabase 既定 |
| パッケージマネージャ | **pnpm** workspaces | モノレポ管理 |
| データ層 | **Supabase** (Auth / Postgres / Storage) | 全部入り |
| レンダリング | **Playwright + Figma Web** | Figma 純正レンダラ使用、公開 S3 不要 |
| MCP SDK | `@modelcontextprotocol/sdk` | 公式 SDK |
| 配置 | ローカル / Fly.io (worker) | PoC は無料枠中心 |

技術選定の詳細根拠は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照。

## このスペックでカバーしないこと（PoC スコープ外）

- 社内 IdP（Okta / Azure AD）連携
- AWS KMS / CloudFront / WAF
- 監査ログの SIEM 連携 / Object Lock
- Figma プラグイン（Tier A）開発
- Tier B 自社 SVG レンダラ
- レート制限・キューイング・大規模スケール
- セキュリティ脅威モデリングの厳密化
- 本番運用設計

これらは PoC が動いてから本番設計（別ドキュメント）で対応する。

## Claude Code への指示の出し方（推奨）

新しいセッションでこのプロジェクトを Claude Code に渡すときは、次のように:

```
このディレクトリ全体を読んでください。
まず README.md → ARCHITECTURE.md → IMPLEMENTATION_PLAN.md → CLAUDE.md の順で読む。
読み終わったら IMPLEMENTATION_PLAN.md の Phase 0 から実装を開始してください。
各 Phase の最後に ACCEPTANCE_TESTS.md の該当チェックリストを満たすことを確認してください。
```

Claude Code は IMPLEMENTATION_PLAN.md のフェーズ順に沿って、各 spec を参照しながらコードを書いてくれます。
