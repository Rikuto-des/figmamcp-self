# 提案: Playwright ベースの自作 Figma MCP

> **このドキュメントの目的**
> Figma 公式 MCP がセキュリティ/ガバナンス上の理由で全面禁止されている問題に対し、
> 「Playwright のスクリーンショット機能で代替できるのでは」という構想と、
> その仮説に基づいて作った PoC 実装 (`packages/figma-mcp-service`) をチームに共有する。
>
> 想定読者: エンジニア / デザインエンジニア
> ステータス: PoC 実装済み (Phase 7 完了) — 本番化の是非をチームで議論したい

---

## 1. 背景と課題

私たちはデジタルプロダクトデザイナー / エンジニアとして、Figma とコーディング AI
(GitHub Copilot, Claude) を併用して開発している。開発環境は **GitHub Codespaces 上に限定**
されており、ローカル開発は禁止されている。

デザインを AI に渡す自然な手段が Figma 公式 MCP だが、**社内では全面禁止**されている。

### なぜ公式 MCP が禁止なのか

公式 MCP の `get_image` 系ツールが選択されると、内部的に Figma の **画像エクスポート API**
が呼ばれる。その結果:

- 画像が **公開 S3 バケット** (`figma-alpha-api.s3.us-west-2.amazonaws.com`) に保存される
- 保持期間が **約 30 日** と長く、URL を知っていれば誰でもアクセスできる
- TTL やアクセス制御をこちら側でコントロールできない

→ **デザイン資産が意図せず外部の公開ストレージに 30 日残る**。これがセキュリティ/ガバナンス
上、許容できないという判断。

---

## 2. 仮説

> **公式 MCP の問題は「Figma のエクスポート API を叩くこと」そのものにある。**
> エクスポート API を一切使わず、Figma の Web キャンバスをブラウザで描画して
> その画素を直接撮れば、公開 S3 経路は構造的に存在しなくなる。

Codespaces は VM である。そこで **Playwright (ヘッドレス Chrome) を動かせれば**、
Figma の Web アプリを開いてキャンバスのスクリーンショットを撮れる。

```
Playwright で Figma Web を描画 → スクショを VM ローカルで撮影
  → そのバイト列を AI に直接渡す
```

この方式なら:

- Figma のエクスポート API を **一度も叩かない** → 公開 S3 にファイルが生成されない
- 画像バイトは **VM プロセス内** で完結し、中間ストレージを経由しない
- レンダリングは Figma 純正エンジン (Web アプリ) なので **見た目の忠実度は 100%**

「VM 上で Playwright スクショ → VM ローカルで VSCode に表示 → AI に渡す」というフローが
成立すれば、公式 MCP よりかなりセキュアになる、というのが仮説。

---

## 3. 提案する構成

```
┌─────────────────────────────────────────────────────────┐
│  GitHub Codespaces (VM)                                  │
│                                                          │
│  ┌──────────────┐   MCP (HTTP)   ┌────────────────────┐  │
│  │ VS Code      │ ────────────▶  │ figma-mcp-service  │  │
│  │ + Copilot/AI │ ◀────────────  │  (Hono + MCP SDK)  │  │
│  └──────────────┘   base64 PNG   └─────────┬──────────┘  │
│                                            │             │
│                                  ┌─────────▼──────────┐  │
│                                  │ Playwright         │  │
│                                  │ (headless Chrome)  │  │
│                                  └─────────┬──────────┘  │
└────────────────────────────────────────────┼─────────────┘
                                              │ Figma セッション cookie で認証
                                              ▼
                                   ┌────────────────────┐
                                   │ Figma Web (canvas) │
                                   └────────────────────┘
```

### 構成要素

| コンポーネント | 役割 |
|---|---|
| **MCP サーバ** | AI クライアント (Copilot/Claude) に MCP ツールを公開。HTTP transport。 |
| **Playwright** | ヘッドレス Chrome で Figma Web を開き、キャンバスをスクショ。 |
| **Figma セッション** | Playwright の `storageState` (cookie) を使い、個人アカウントでログイン状態を保持。 |
| **Supabase** | 認証 (JWT / API Key)、キャッシュメタデータ、監査ログ。**プライベート**バケット。 |

### MCP ツール (AI に見えるインターフェース)

- **`figma_get_screenshot`** — Figma URL を渡すとノードの PNG を返す
- **`figma_get_node_info`** — ノードの構造化メタデータ (名前/型/座標/サイズ/塗り/テキスト) を返す

利用者は **Figma URL を貼るだけ**。AI がツールを選んで呼ぶ。

---

## 4. セキュリティの肝 — なぜこれがセキュアなのか

| 観点 | 公式 MCP | この構成 |
|---|---|---|
| 画像の出力先 | **公開 S3** (30日保持) | VM プロセス内のメモリのみ |
| 画像バイトの流れ | エクスポート API → 公開 URL | Playwright → MCP → AI に in-process で直接 |
| 署名 URL / 公開 URL | 生成される | **一切生成しない** |
| キャッシュ保存先 | 制御不能 | 会社管理の**プライベート**ストレージ (PoC では Supabase) |
| アクセス制御 | なし | ユーザ単位の分離 (`created_by` フィルタ + RLS) |

**最重要の不変条件**: スクショのバイト列は Playwright が撮った瞬間からメモリ上にあり、
MCP レスポンスで base64 化されて AI に渡るまで、**公開 URL を一度も経由しない**。
キャッシュ用に Supabase Storage へコピーは置くが、それは権限付きの service_role
ダウンロードでしか取り出せず、署名 URL は発行しない。

### 残る論点 (チームで詰めたい)

VM 内が安全でも、**スクショを AI モデルに渡した時点で画像はモデルプロバイダ
(Anthropic / GitHub) に送信される**。公開 S3 漏洩は防げるが、「デザイン画像が
外部 AI に渡る」事実は公式 MCP と変わらない。ここはガバナンス上、別途整理が必要。

---

## 5. 現状の実装 (PoC は既に動いている)

この仮説に基づく PoC を `packages/figma-mcp-service` に実装済み (Phase 7 完了)。

### 技術スタック

- **Hono** v4.6 — HTTP サーバ / ルーティング
- **@modelcontextprotocol/sdk** v1.0 — MCP サーバ (`WebStandardStreamableHTTPServerTransport`)
- **Playwright** v1.49 — ヘッドレス Chrome 自動化
- **Supabase** — Auth / Postgres / Storage
- **Zod** — 環境変数・リクエストの実行時バリデーション
- pnpm モノレポ (`shared` で型契約を共有)

### Playwright によるレンダリングフロー (`src/render.ts`)

1. `storageState` から Figma ログインセッションを復元
2. ヘッドレス Chrome を起動 (ボット検知回避: `--enable-automation` を無効化、
   `webdriver` プロパティ除去、実 Chrome の UA を偽装)
3. `figma.com/design/{fileKey}/_?node-id={nodeId}` に遷移
4. ログインリダイレクト検知 → 未認証なら `figma_unauthenticated` エラー
5. ダイアログを閉じ、左右パネル/ツールバーを CSS で非表示化
6. `Shift+0` (選択にズーム) でノードを画面に収める
7. canvas 要素の bounding box を取得し、その範囲を PNG でスクショ
8. 同時実行は `p-limit` で **最大 2** に制限 (メモリ対策)

### 画像バイトの流れ (`src/services/render-service.ts`)

3 段キャッシュ戦略:

1. **fast-path**: `(file_key, node_id, format, scale)` で最新アセットを検索
2. **versioned cache**: `SHA256(fileKey|nodeId|format|scale|fileVersion)` で検索
3. **キャッシュミス時**: Playwright で新規レンダリング

いずれの経路でも **署名 URL は発行しない**。キャッシュヒット時は service_role で
直接ダウンロード、新規レンダリング時はメモリ上の Buffer をそのまま使う。
`figma_get_screenshot` ツールは Buffer を base64 化して MCP レスポンスに載せるだけ。

### 認証

- **Supabase JWT** (`Bearer eyJ...`) または **API Key** (`fmps_` プレフィックス)
- API Key は SHA256 ハッシュのみ DB 保存 (生のキーは保存しない)
- IP 単位のブルートフォース対策 (60 回失敗/分でレート制限)
- 全 Supabase クエリが `created_by = userId` でユーザ分離 (RLS 併用)

### Supabase スキーマ (`supabase/migrations/`)

| テーブル | 用途 |
|---|---|
| `assets` | キャッシュメタデータ。`expires_at` で自動失効 (機密 300s / 内部 900s) |
| `audit_log` | 全レンダリング/メタデータ取得イベントの監査証跡 |
| `api_keys` | リモート MCP 用 API キー (ハッシュ保存) |

`delete_expired_assets()` 関数で期限切れアセットを Storage ごと自動削除。

### セットアップ / 主要コマンド

```bash
pnpm install
pnpm login-figma            # Figma 個人アカウントを Playwright で保存 (初回のみ)
pnpm dev                    # figma-mcp-service を localhost:3000 で起動
pnpm issue-api-key --user <id> --label "..."   # リモート用 API キー発行
pnpm test                   # vitest (URL パーサ / ユーザ分離)
```

---

## 6. デプロイ構成 — Supabase の役割と本番への移行方針

### 前提①: 「敵」は公開 S3 であって S3 そのものではない

公式 MCP がガバナンス NG なのは、Figma が握る **公開・制御不能な S3** にデザイン画像が
30日残るから。**自社管理下のプライベートストレージ**なら、ポリシー / 保持期間 / 暗号化 /
アクセス制御を全て自分で握れる。本質は「Supabase を使うこと」ではなく
**「制御可能なプライベートストレージを使うこと」**。

### 前提②: Supabase は PoC 専用の足場

Supabase は **Auth + Postgres + Storage の3機能の詰め合わせ**。PoC を速く組むための
便宜上の選択であり、本番での使用は前提にしていない。3役割を個別に見て判断する。

| Supabase の役割 | 本番での扱い |
|---|---|
| **Auth** (JWT / API キー) | **捨てる。会社の IdP に統合する** (後述) |
| **Postgres** (キャッシュ索引 + 監査ログ) | 会社の DB / ログ基盤に移行。省略も検討可 |
| **Storage** (PNG キャッシュ) | 会社のプライベート Blob ストレージに移行。省略も検討可 |

### 認証: 会社の IdP に OIDC で統合する (最重要)

本番では独自 JWT / `fmps_` API キーは**使うべきでない**。
会社が管理する IdP に **OIDC** で繋ぐ。どの基盤でも考え方は同じ:

| 会社の基盤 | 統合先 |
|---|---|
| Microsoft / Azure | **Entra ID (旧 Azure AD)** の OIDC / SSO |
| Google Workspace | **Google SSO** (OIDC) |
| AWS 中心 | **IAM Identity Center** / Cognito + フェデレーション |

> **今どれかわからなくても問題ない。**
> MCP サービスを「OIDC トークンを検証する」だけに設計しておけば、
> どの IdP でも差し替え可能。社内ネットワーク / VPN /
> ID 認識プロキシ (Azure App Proxy, GCP IAP 等) の内側に置けば
> アプリ側で認証を持たない選択肢すらある。

ガバナンス上のメリット: 退職者の即時アクセス遮断・SSO ログインの監査が
会社の既存仕組みで一元管理できる。

### 本番の構成イメージ (社内基盤に寄せる)

具体的なクラウドは会社の基盤次第だが、役割のマッピングは共通:

| 役割 | 社内基盤 (例) |
|---|---|
| MCP + Playwright 実行 | **常駐コンテナ** (ECS Fargate / Azure Container Apps / Cloud Run) |
| 認証 | **会社の IdP** (Entra ID / Google SSO / IAM) |
| 画像キャッシュ | **プライベート Blob** (S3 / Azure Blob Storage / GCS) |
| メタデータ DB | **会社の Postgres** (RDS / Azure Database / Cloud SQL) |
| 監査ログ | **会社のログ基盤** (CloudWatch / Azure Monitor / SIEM) |
| 期限切れ削除 | **定期ジョブ** (Lambda cron / Azure Functions Timer 等) |

注意点:
- **サーバーレス (Lambda 等) は MCP 本体には不向き**。headless Chrome は動くが、
  MCP セッションがプロセス内メモリ管理 + Playwright が 5〜15秒かかるため、
  **常駐コンテナ**が必要 (min 1 タスク)。
- **Blob ストレージの TTL は最小1日単位が多い**。細かい秒単位の失効はアプリ側 cron で削除。
- **in-process 不変条件 (§4) は維持**。どのストレージでも AI への経路に presigned URL を挟まない。

### 最小構成オプション: Blob も DB もなくす

デザインチーム数人規模なら、キャッシュと DB を省いた最小構成も成立する:

```
常駐コンテナ 1台
  ├ MCP + Playwright
  ├ 認証     → ID 認識プロキシ + 会社 IdP (アプリは OIDC 検証のみ)
  ├ キャッシュ → コンテナのローカルディスク (DB も Blob も不要)
  └ 監査     → 構造化ログ → 会社のログ基盤に集約
```

トレードオフ: コンテナ再起動でキャッシュが消える / 水平スケールには共有ストレージが必要。
小規模チームなら許容範囲。スケールが要件になった時点で Blob + DB を足せばよい。

### PoC の現状: Fly.io / Supabase で方式を検証中

**本番は社内基盤だが、現時点で社内環境に触れる権限がない**ため、PoC では
アーキテクチャの妥当性を **Fly.io + Supabase** で検証している。

```
PoC (検証用)              本番 (社内基盤)
─────────────────        ────────────────────────────
Fly.io               →   常駐コンテナ (社内クラウド)
Supabase Auth        →   会社の IdP (OIDC)
Supabase Storage     →   プライベート Blob ストレージ
Supabase Postgres    →   会社の Postgres / ログ基盤
```

→ PoC で検証したいのは **「Playwright スクショ = エクスポート API 不使用」という方式そのもの**。
Fly.io / Supabase という具体のサービス選定ではない。

---

## 7. 未検証のポイント / リスク

| 項目 | 内容 |
|---|---|
| **Codespaces での Playwright 動作** | ヘッドレス Chrome が Codespaces VM で安定稼働するか要検証 (メモリ、`--no-sandbox` 前提)。 |
| **Figma セッションの管理** | `storageState` (cookie) をどこに保持し、どう更新するか。Codespaces は ephemeral。**リポジトリへのコミットは厳禁**。Fly.io 用に base64 で env 渡しする経路 (`FIGMA_STATE_JSON`) は実装済み。 |
| **Figma の利用規約** | Playwright による自動ログイン/操作が Figma の ToS と整合するか、社内で確認が必要。 |
| **ボット検知** | Figma 側の検知が強化されると UA 偽装等が効かなくなる可能性。 |
| **AI へのデータ送信** | §4 の通り、画像がモデルプロバイダに渡る点はガバナンス整理が別途必要。 |
| **スケール** | MCP セッションはプロセス内メモリ管理。水平スケールには Redis 等が必要 (現状は単一プロセス前提)。 |

---

## 8. チームに相談したいこと

1. **この方式 (Playwright スクショ = エクスポート API 不使用) で公式 MCP 禁止の懸念は
   解消されるか?** ガバナンス担当の合意が取れるか。
2. **「画像が外部 AI に渡る」点** をどう整理するか (公式 MCP と同じ論点)。
3. **Figma 自動操作の ToS** をどう扱うか。
4. **社内基盤へのアクセス権** — 本番構成 (§6) の検証には社内クラウド環境が必要。
   PoC で方式の妥当性を示せたら、環境の払い出しを依頼したい。
5. **会社の IdP は何か** — Azure Entra ID / Google SSO / AWS IAM のどれかによって
   認証統合の具体的な実装が決まる。セキュリティ担当に確認が必要。
6. PoC を本番運用 (社内基盤) に進めるべきか、それとも構想段階で止めるか。

---

## 付録: 参考ドキュメント

- [docs/ARCHITECTURE.md](./ARCHITECTURE.md) — 詳細なシステム設計
- [docs/IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) — フェーズごとの実装計画
- [docs/CLAUDE.md](./CLAUDE.md) — 開発規約 (絶対のルール含む)
- [docs/specs/](./specs/) — supabase / renderer-worker / mcp-server / remote-mcp 仕様
