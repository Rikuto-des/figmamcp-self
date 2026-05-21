# CLAUDE.md — Claude Code 規約

このファイルは Claude Code がこのプロジェクトで作業するときの規約・コマンド・コード規約を集約したもの。**作業開始時に必ず最初に読む**。

## プロジェクト概要

社内ガバナンス制約下で、Figma 公式 MCP (`/v1/images` 経由・公開 S3 利用) の代替を実装する PoC。Playwright で Figma Web をヘッドレス操作してスクリーンショットを取得し、Supabase Storage 経由で配信する。

詳細は [README.md](./README.md) → [ARCHITECTURE.md](./ARCHITECTURE.md) → [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) の順に読むこと。

## 必須コマンド

### セットアップ
```bash
pnpm install                          # 全パッケージの依存を入れる
cp .env.example .env                  # 環境変数雛形をコピー (.env を埋める)
pnpm --filter renderer-worker exec playwright install chromium
pnpm --filter renderer-worker tsx scripts/login-figma.ts   # 初回 Figma ログイン
```

### 開発
```bash
pnpm dev:worker                       # renderer-worker をローカル起動 (ポート 3000)
pnpm dev:mcp                          # mcp-server を stdio で起動 (動作確認用、通常は VS Code が起動)
pnpm -r build                         # 全パッケージビルド
pnpm test                             # 全テスト実行
pnpm format                           # Prettier
```

### Supabase
```bash
supabase db push                      # migrations を本番に反映
supabase db reset                     # 開発時、ローカル DB を初期化
supabase functions deploy             # PoC では使わない
```

## コード規約

### 言語・スタイル
- **TypeScript strict** モード必須。`any` は禁止（避けられないときはコメント必須）
- ESM (`"type": "module"`)
- import パスは拡張子つき (`./foo.js` — Node ESM 規約)
- フォーマットは Prettier、コンフィグはルート `.prettierrc` を共有

### ファイル命名
- 小文字 + ハイフン: `url-parser.ts`, `get-screenshot.ts`
- テストは `.test.ts` を後置: `url-parser.test.ts`

### モジュール構造
- 1ファイル 1 責務
- export は名前付き優先（default export は CLI entry のみ）
- 型は `@figma-mcp-poc/shared` に集約。各パッケージでは内部 helper のみ private 型として定義

### ロギング
- **mcp-server では stdout に出力禁止**。stdio が JSON-RPC で汚染される
  - デバッグは `console.error` (stderr) または `MCP_LOG_FILE` 環境変数で指定したファイル
- worker は通常通り console.log OK
- 構造化ログ推奨 (JSON 行)

### エラーハンドリング
- 外部 API 呼び出しは必ず try/catch
- worker は HTTP エラーコードを返す: 400 (bad input), 401 (no auth), 403 (no permission), 404 (not found), 422 (figma render failed), 500 (internal), 504 (timeout)
- mcp-server がエラーを受けた場合は MCP の `isError: true` 付きで返す

### 秘密情報
- **絶対にコミットしない**: `.env`, `.playwright-state/`, `~/.config/figma-mcp-poc/`
- `.gitignore` に追加済みを確認
- ログ・エラーメッセージにトークンを含めない
- ユーザーが共有してきた `.env` の中身を、コード内でハードコードしない

## 重要な制約

### MCP プロトコル特有
- VS Code の `.vscode/mcp.json` ルートキーは `"servers"` であって `"mcpServers"` ではない（Claude Desktop と異なる）
- stdio transport では stdout が JSON-RPC 専用。MCP server 内で `console.log` を絶対に使わない
- ツール description は Copilot Agent がツールを自動選択するための主要シグナル。「Use this when the user mentions/pastes a figma.com URL」のような自動発火条件を明示

### Figma 関連
- `/v1/images` エンドポイントは**絶対に使わない**（公開 S3 にデータが乗るためガバナンス NG）
- ノード構造取得用に `/v1/files/:key/nodes?ids=...` は使ってよい（JSON のみ返る）
- Figma セッションは Playwright `storageState` で保持。期限切れたら `scripts/login-figma.ts` で再ログイン
- 個人 Figma アカウントのみ使用。社内 Figma org のファイルは触らない

### Supabase 関連
- worker は **service_role キー**、mcp-server は **anon キー** + 個人 JWT
- service_role キーが mcp-server 側にも入らないよう注意（mcp-server はクライアントサイド扱い）
- RLS が有効になっている。worker は service_role で RLS bypass、mcp-server は JWT で自分の行のみアクセス

### Playwright 関連
- worker 1 プロセスにつき browser context は 1 つで使い回す（毎回新規起動するとオーバーヘッド大）
- 同時実行は最大 2 並列まで（メモリ不足対策）。シリアル実行で OK
- スクリーンショットは canvas DOM の bounding box を使う。フルページではない

## 進め方

### 新しいフェーズに入るとき
1. [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) の該当 Phase を読む
2. 関連する spec/reference を読む
3. 作業開始
4. [ACCEPTANCE_TESTS.md](./ACCEPTANCE_TESTS.md) の該当チェックリストで確認

### スタックしたとき
1. [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) §「よく出るエラーと対処」を参照
2. [ACCEPTANCE_TESTS.md](./ACCEPTANCE_TESTS.md) で「何が動くべきだったか」逆算
3. ログを確認（worker は console、mcp-server は MCP_LOG_FILE）

### ユーザーに確認が必要なとき
- Supabase の人手作業（プロジェクト作成、ユーザー作成、bucket 作成）はユーザーにお願いする
- Figma ログインは `scripts/login-figma.ts` をユーザーに実行してもらう
- Fly.io デプロイなどクラウド変更が伴う作業はユーザー確認後に実行

## やってはいけないこと

- 公開 S3 経由で画像を取得する経路を実装する（`/v1/images` 使用）
- 本番要件（KMS, CloudFront, IdP federation 等）を PoC スコープで実装する
- 認証情報・トークンをログ出力・コミット
- mcp-server で `console.log` を使う (Phase 4-6 の stdio 期のみ。Phase 7 以降は OK)
- Playwright で他人の Figma org にアクセスする
- Supabase service_role キーを mcp-server パッケージに渡す (Phase 4-6)
- Phase 7 で、`assets` / `audit_log` 関連クエリに `created_by = ctx.userId` フィルタを抜かす (per-user 分離が崩壊する)
- 「動くけど雑」な状態で次のフェーズに進む（ACCEPTANCE_TESTS を満たしてから）

## 関連リンク

- [./](./) — 全仕様書（このディレクトリ）
- [Supabase docs](https://supabase.com/docs)
- [Playwright docs](https://playwright.dev/)
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Figma REST API](https://www.figma.com/developers/api)
- [VS Code MCP](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
