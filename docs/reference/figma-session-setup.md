# Figma セッションの永続化 (Playwright `storageState`)

renderer-worker は Figma Web を Playwright で開いてレンダリングする。毎回ログインを要求されないよう、`storageState` (cookies + localStorage) をファイルに保存し、ヘッドレス起動時に注入する。

## 1. 初回ログイン手順

```bash
pnpm login-figma
# = pnpm --filter renderer-worker tsx scripts/login-figma.ts
```

スクリプトの動作:

1. `chromium.launch({ headless: false })` で実ブラウザを起動
2. 新規 context を作成し `https://www.figma.com/login` を開く
3. **ユーザーが手で** Figma 個人アカウントにログイン (Google SSO でも可)
4. ログイン完了したら任意のページ (`https://www.figma.com/files/recent`) に遷移したことを確認
5. ターミナルで Enter キーを押す → `context.storageState({ path: '.playwright-state/figma.json' })` で保存
6. ブラウザを閉じる

## 2. ファイル

```
<repo>/
└── .playwright-state/
    └── figma.json    # 機密 (cookies 含む)、.gitignore 済み
```

## 3. worker での読み込み

`packages/renderer-worker/src/render.ts`:

```ts
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: '.playwright-state/figma.json',
  viewport: { width: 1440, height: 900 },
});
```

シングルトン context を全リクエストで使い回す。

## 4. 期限切れ・再ログイン

Figma セッションは概ね 数週間〜数ヶ月で expire する。レンダリング時に Figma が `/login` にリダイレクトしてきたら:

- worker は `figma_unauthenticated` (HTTP 422) を返す
- ユーザーは `pnpm login-figma` を再実行して `.playwright-state/figma.json` を上書き

## 5. デプロイ (Phase 6/7)

Fly.io 環境では `.playwright-state/figma.json` を fly secret に注入する:

```bash
fly secrets set FIGMA_STATE_JSON="$(base64 < .playwright-state/figma.json)"
```

サーバー起動時に `process.env.FIGMA_STATE_JSON` を decode して一時ファイル化 (`/tmp/figma-state.json`) し、それを `storageState` に渡す。

## 6. セキュリティ注意

- `.playwright-state/figma.json` は **個人 Figma アカウントの authentication cookie を含む**。社内 Figma org のクッキーは入れない
- 共有・コミット禁止 (`.gitignore` 済み)
- 再ログインで rotation する運用
