# ARCHITECTURE — システム構成

## 1. 目標と制約

### 1.1 機能要件
- 開発者が Figma の「Copy link to selection」で得た URL を VS Code Copilot Chat に貼ると、その URL のフレーム/コンポーネントの画像が AI のコンテキストに入る
- 同じ URL からノードの構造情報 (テキスト、サイズ、色) も取れる
- 結果は AI が「コード生成」「レビュー」「説明」に使える品質

### 1.2 非機能要件 (PoC 範囲)
- **Figma 公開 S3 (`figma-alpha-api.s3.us-west-2.amazonaws.com`) を一切経由しない**
- 画像バイトは社内側の管理下にあるストレージ (Supabase Storage) にのみ保存
- 配布は署名付き URL のみ、認証なしアクセス不可
- 開発者の手間ゼロ（URL ペースト1ステップ）

### 1.3 PoC 範囲外
- 社内 IdP 連携、KMS、CloudFront、WAF、SIEM
- マルチテナント、レート制限、スケール
- Figma Enterprise プラグイン

## 2. システム全体像

```
┌──────────────────────────────────────────────────────────────────────┐
│  Developer Workstation (VS Code or Codespaces)                       │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  VS Code + GitHub Copilot Chat (Agent mode)                   │   │
│  │   .vscode/mcp.json で MCP サーバー登録                        │   │
│  └──────────────────────────────┬────────────────────────────────┘   │
│                                 │ stdio (JSON-RPC, MCP protocol)     │
│                                 ▼                                    │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  @figma-mcp-poc/mcp-server  (Node.js, ローカル子プロセス)     │   │
│  │   - registerTool: figma_get_screenshot, figma_get_node_info   │   │
│  │   - Supabase Auth でログイン（cached session）                │   │
│  │   - HTTPS で Renderer Worker を呼ぶ                           │   │
│  └──────────────────────────────┬────────────────────────────────┘   │
└──────────────────────────────────┼───────────────────────────────────┘
                                   │ HTTPS + Bearer (Supabase JWT)
                                   ▼
        ┌──────────────────────────────────────────────────────┐
        │  @figma-mcp-poc/renderer-worker                       │
        │  (Node.js + Playwright, Fly.io か Local)              │
        │                                                       │
        │   1. JWT を Supabase で検証                            │
        │   2. URL を file_key + node_id にパース               │
        │   3. assets テーブルでキャッシュ確認                  │
        │   4. ヒットなら既存 asset を返す                      │
        │   5. ミスなら:                                         │
        │      a. Playwright で Figma Web を開く                │
        │         (永続セッションでログイン済み)                 │
        │      b. node-id 付き URL でナビゲート                 │
        │      c. Shift+1 で Zoom to Selection                  │
        │      d. canvas 領域をスクショ                         │
        │      e. Supabase Storage に PNG を PUT                │
        │      f. assets / audit_log に書き込み                 │
        │   6. signed URL を発行して返す                        │
        └─────────┬──────────────────────────────────┬──────────┘
                  │                                  │
                  ▼                                  ▼
       ┌──────────────────────┐        ┌────────────────────────┐
       │  Figma Web           │        │  Supabase              │
       │  (figma.com)         │        │  - Auth (JWT)          │
       │  - 個人アカウント     │        │  - Postgres            │
       │    でログイン済み     │        │    (assets, audit_log) │
       │  - REST API も使用   │        │  - Storage             │
       │    (node 構造取得)    │        │    (private bucket)    │
       └──────────────────────┘        └────────────────────────┘
                                                  │
                                       signed URL │ (TTL 5〜15分)
                                                  ▼
                                         (mcp-server がダウンロード)
                                                  │
                                                  ▼
                                       MCP image content として
                                       Copilot Chat に表示
```

## 3. 主要コンポーネント

### 3.1 mcp-server (TypeScript / Node.js)
- VS Code が stdio で起動するサブプロセス
- `@modelcontextprotocol/sdk` を使った MCP サーバー
- 提供ツール:
  - `figma_get_screenshot(figma_url | file_key+node_id, format, scale)` → PNG image
  - `figma_get_node_info(file_key, node_id)` → JSON
- 認証: Supabase Auth, トークンをローカルにキャッシュ
- HTTPS で Renderer Worker を呼ぶだけの薄いプロキシ

### 3.2 renderer-worker (TypeScript / Node.js + Playwright)
- HTTP API サーバー (Hono または Express)
- 主エンドポイント:
  - `POST /render` — 画像取得
  - `POST /node-info` — ノード構造取得（Figma REST 経由）
  - `GET /healthz`
- Playwright で永続コンテキスト管理（Figma セッションを保持）
- Supabase に直接アクセスして storage upload / DB write を実行
- Fly.io の小型 Machine (1GB RAM) または開発機ローカルで稼働

### 3.3 supabase (構成のみ)
- **Auth**: email + password による単一開発者用アカウント
- **Postgres**:
  - `assets` テーブル（メタデータとキャッシュ）
  - `audit_log` テーブル
  - RLS で `created_by = auth.uid()` の自分のものだけ読める
- **Storage**: `figma-assets` private bucket
- **Edge Functions**: PoC では使わない（worker が直接 Supabase クライアントを使う）

## 4. 主要設計判断

### 4.1 なぜ Playwright + Figma Web か

**選択肢:**
- ❌ `/v1/images`: 公開 S3 URL が生成される（ガバナンス NG）
- ❌ Tier B (自社 SVG レンダラ): フォント・エフェクトでフィデリティ落ちる
- ❌ Figma プラグイン: Enterprise 配布 + 自動化に追加ブラウザが必要 → β に収束
- ✅ **Playwright + Figma Web**: Figma の純正レンダラ（C++ → WASM）を使うため品質 100%、自動化容易

Figma の REST API `/v1/images` が公開 S3 経由なのは仕様であり、Figma 公式が「認証強制不可・TTL 変更不可」と明言。回避不能なので使用しない。

### 4.2 なぜ MCP → Edge Function を挟まず直接 Worker を呼ぶか

Edge Function の実行時間制限（数十秒）に対して Playwright は 5〜15秒かかる。マージンが薄く、Edge Function を中間に挟むメリットが薄い。PoC では mcp-server → worker の直接構成で簡潔さを優先。

将来の本番では API Gateway を別途立てる。

### 4.3 なぜ Supabase か

- Auth, DB, Storage が1つに統合 → PoC 構築が早い
- 署名付き URL がデフォルト対応
- RLS で簡易的な認可表現が可能
- 無料枠で完結

### 4.4 なぜ pnpm workspaces のモノレポか

- 3 パッケージ（mcp-server, renderer-worker, shared types）の依存関係をシンプルに
- shared types で API 契約を型レベルで保証
- 個別にデプロイも可能

## 5. データフロー（リクエスト 1 回）

```
1. ユーザーがチャットに Figma URL を貼り「React 化して」と入力
2. Copilot Agent が figma_get_screenshot ツールを選択
3. mcp-server.figma_get_screenshot(figma_url)
4. mcp-server: Supabase token を ensure (cached or refresh)
5. mcp-server: POST https://worker/render {figma_url, scale, format} + Bearer
6. worker: JWT 検証
7. worker: URL パース → file_key, node_id
8. worker: file_meta = Figma REST GET /v1/files/:key?depth=1  ← version 取得
9. worker: cache_key = sha256(file_key|node_id|format|scale|file_version)
10. worker: SELECT * FROM assets WHERE cache_key = ? AND created_by = ?
    - HIT: skip to 16
    - MISS: continue
11. worker: Playwright で Figma Web を開く（永続コンテキスト使用）
12. worker: page.goto(figma_url + 適切なクエリ追加)
13. worker: canvas のレンダリング完了を wait
14. worker: keyboard.press('Shift+1') で Zoom to Selection
15. worker: canvas DOM のスクショ → PNG bytes
16. worker: Supabase Storage に upload (path: <user_id>/<digest>.png)
17. worker: INSERT INTO assets (...) + INSERT INTO audit_log (...)
18. worker: storage.createSignedUrl(path, ttl=300)
19. worker: response { asset_id, signed_url, classification, tier, cache_hit }
20. mcp-server: signed_url を fetch して bytes 取得
21. mcp-server: return { content: [{type:image, data:base64, mimeType}, {type:text, text:metadata}] }
22. Copilot: 画像をコンテキストに含めて回答生成
```

## 6. セキュリティモデル (PoC レベル)

- 開発者は事前に Supabase Auth で個人アカウント作成
- mcp-server は email/password で初回ログイン → token を `~/.config/figma-mcp-poc/session.json` (mode 0600) に保存
- worker は JWT を Supabase API で検証
- Storage は private bucket、署名 URL 経由でのみアクセス
- worker と Supabase 間は service_role キー（worker 内部にのみ存在、コミットしない）
- Figma セッションは worker 内の Playwright `storageState` に保存（個人 Figma アカウント、再ログインフロー手動）

PoC として割り切る部分:
- email/password を `.env` で扱う（本番では OAuth Device Flow に置換）
- IP 制限なし
- 監査ログは Postgres テーブルだけ
- KMS なし、Supabase の既定暗号化のみ

## 7. デプロイ形態

| コンポーネント | PoC | 開発中の動かし方 |
|---|---|---|
| mcp-server | ローカル/Codespaces で stdio 子プロセス | VS Code が自動起動 |
| renderer-worker | ローカル開発時は localhost:3000、本格テスト時 Fly.io | `pnpm dev` or `fly deploy` |
| supabase | クラウド (個人プロジェクト) | ブラウザでダッシュボード |

## 8. ファイル構成（モノレポ）

```
figma-mcp-poc/
├── README.md
├── CLAUDE.md
├── package.json                 # pnpm workspaces root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
├── .gitignore
│
├── packages/
│   ├── shared/                  # 共有型定義
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── api.ts           # API 契約の型
│   │   │   └── db.ts            # DB スキーマ型
│   │
│   ├── mcp-server/              # MCP wrapper
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── server.ts        # entry
│   │   │   ├── auth.ts          # Supabase Auth
│   │   │   ├── client.ts        # worker HTTP client
│   │   │   ├── tools/
│   │   │   │   ├── get-screenshot.ts
│   │   │   │   └── get-node-info.ts
│   │   │   └── url-parser.ts
│   │   └── bin/
│   │       └── mcp-server.js    # CLI entry
│   │
│   └── renderer-worker/         # Playwright service
│       ├── package.json
│       ├── tsconfig.json
│       ├── Dockerfile           # Fly.io 用
│       ├── fly.toml
│       ├── src/
│       │   ├── server.ts        # Hono HTTP server
│       │   ├── render.ts        # Playwright render logic
│       │   ├── figma-rest.ts    # Figma REST client
│       │   ├── supabase.ts      # Supabase admin client
│       │   ├── url-parser.ts    # 共通 URL パース
│       │   └── auth.ts          # JWT verification
│       └── scripts/
│           └── login-figma.ts   # 初回ログインで storageState 作成
│
├── supabase/                    # Supabase プロジェクト
│   ├── config.toml
│   └── migrations/
│       └── 20260520000000_init.sql
│
└── docs/                        # このドキュメントセット
```

## 9. Phase 7 後の将来像 (リモート MCP)

Phase 6 完了で PoC は動くが、本番展開を見据えて Phase 7 で次の構成に進化させる:

```
[Developer Workstation (Codespaces / local VS Code)]                  
   │                                                                  
   │ Bearer Token (FIGMA_MCP_TOKEN)                                   
   │ — dev 機にあるのはこれ 1 つだけ —                                
   ▼                                                                  
[VS Code]                                                             
   │ .vscode/mcp.json:                                                
   │   { type: "http", url: "https://figma-mcp.example.com/mcp",      
   │     headers: { Authorization: "Bearer ${env:FIGMA_MCP_TOKEN}" } }
   │                                                                  
   │ HTTPS POST /mcp (JSON-RPC over HTTP/SSE)                         
   ▼                                                                  
┌─────────────────────────────────────────────────────────────────┐  
│  figma-mcp-service (Fly.io)                                      │  
│   - POST /mcp  (MCP HTTP transport)                              │  
│   - Bearer 検証 (Supabase JWT or API Key)                        │  
│   - MCP tools (in-process): get_screenshot, get_node_info        │  
│   - Playwright (in-process, browser context shared)              │  
│   - Supabase クライアント (service_role)                          │  
└──────────────────────┬───────────────────────────┬──────────────┘  
                       │                            │                  
                       ▼                            ▼                  
                  Figma Web                     Supabase               
                                                (Auth/DB/Storage)      
```

**stdio 版との違い**:

| 観点 | Phase 4-6 (stdio) | Phase 7 (HTTP) |
|---|---|---|
| mcp-server の場所 | 各 dev 機内 | 1 ヶ所 (Fly.io) |
| dev 機の credentials | Supabase email+pwd, Figma PAT, service_role | **API Key 1 つだけ** |
| Codespaces 立ち上げ準備 | secret 多数 + cloning + playwright install | secret 1 つだけ |
| mcp-server の更新 | 各 dev が pull & build | 1 ヶ所デプロイで全員に反映 |
| 監査ログ | dev 機側で取れない | サーバー側 100% |
| デプロイ単位 | mcp-server + renderer-worker (2) | figma-mcp-service (1) |
| Playwright session | 各 dev 機が持つ可能性 | 1 ヶ所 (Fly.io secret) |

Phase 7 の詳細は [specs/remote-mcp-spec.md](./specs/remote-mcp-spec.md) を参照。

## 10. 関連ドキュメント

- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) — 実装手順 (Phase 0〜7)
- [specs/supabase-spec.md](./specs/supabase-spec.md) — Supabase 詳細
- [specs/renderer-worker-spec.md](./specs/renderer-worker-spec.md) — Worker 詳細 (Phase 3)
- [specs/mcp-server-spec.md](./specs/mcp-server-spec.md) — MCP server (Phase 4, stdio)
- [specs/api-contracts.md](./specs/api-contracts.md) — API 契約
- [specs/remote-mcp-spec.md](./specs/remote-mcp-spec.md) — リモート MCP (Phase 7)
