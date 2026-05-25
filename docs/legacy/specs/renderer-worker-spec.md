# renderer-worker 詳細スペック (Phase 3)

## 1. 概要

Playwright + Hono の HTTP API サーバー。`POST /render` で Figma URL を受け取り、Playwright で Figma Web をレンダリングして Supabase Storage に PNG をアップロードし、署名付き URL を返す。

Phase 3 完了時点では stdio mcp-server から HTTP で呼ばれる。Phase 7 で同じパッケージに MCP transport を merge する。

## 2. 起動と依存

```bash
pnpm dev:worker        # tsx watch (開発)
pnpm --filter renderer-worker build && pnpm --filter renderer-worker start   # 本番起動
```

Dependencies:
- `hono` + `@hono/node-server` — HTTP
- `playwright` — Browser 自動化
- `@supabase/supabase-js` — Storage / DB
- `zod` — request validation
- `@figma-mcp-poc/shared` — 型

## 3. ルート構成

| Method | Path | Auth | 用途 |
|---|---|---|---|
| GET | `/healthz` | none | ヘルスチェック |
| POST | `/render` | Bearer (JWT) | レンダリング (キャッシュ含む) |
| POST | `/node-info` | Bearer (JWT) | Figma REST のプロキシ |

詳細 contract は [`api-contracts.md`](./api-contracts.md)。

## 4. Playwright レンダリング手順

### 4.1 Browser context のシングルトン化

モジュールスコープで Promise をメモ化:

```ts
let contextPromise: Promise<BrowserContext> | null = null;
async function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
      return browser.newContext({
        storageState: process.env.FIGMA_STATE_PATH ?? '.playwright-state/figma.json',
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 2,
      });
    })();
  }
  return contextPromise;
}
```

### 4.2 並列制御

同時実行は最大 2 並列。`p-limit(2)` を `renderNode` の入口でかける。3 つ目以降は queue 待ち。

### 4.3 レンダリング 1 回の手順

1. `const page = await context.newPage()`
2. `page.goto(figmaUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })`
3. ログイン切れ検出: `page.url()` が `/login` を含むなら `figma_unauthenticated` でエラー
4. canvas 描画完了を待機:
   - セレクタ例: `canvas[data-testid="canvas-container"]` または `canvas#fullscreen-canvas-react`
   - `page.waitForSelector(selector, { timeout: 15_000 })`
   - 追加で `page.waitForTimeout(800)` で初回描画を安定させる
5. UI を隠す CSS injection (optional):
   ```ts
   await page.addStyleTag({ content: `
     [data-testid="left-panel"], [data-testid="right-panel"], 
     [data-testid="canvas-toolbar"] { display: none !important; }
   `});
   ```
6. Zoom to Selection: `await page.keyboard.press('Shift+1')` (node が選択済みであることが前提。URL に `node-id` があれば自動選択される)
7. ノードの bounding box を取得:
   - DOM 経由で `[data-testid="canvas-container"]` 内の "selection" 要素を `evaluate` して boundingClientRect を取得
   - もしくは Figma の `figma.viewport` (window から見える) を `evaluate` で読む — 実装難度が高いので canvas 全体スクショで妥協する代替案あり
8. `await page.screenshot({ clip: { ... }, type: 'png' })` で bytes 取得
9. `await page.close()` (context は閉じない)

### 4.4 エラー分類

| 状況 | error.code | HTTP |
|---|---|---|
| Figma へのリダイレクトが `/login` | `figma_unauthenticated` | 422 |
| `waitForSelector` timeout | `playwright_timeout` | 504 |
| Figma が "Not Found" 表示 | `figma_node_not_found` | 404 |
| `page.screenshot` が throw | `figma_render_failed` | 422 |
| その他 unknown | `internal_error` | 500 |

## 5. キャッシュ

### 5.1 cache_key の組み立て

```ts
import { createHash } from 'node:crypto';

function cacheKey(opts: { fileKey: string; nodeId: string; format: string; scale: number; fileVersion: string }) {
  return createHash('sha256')
    .update([opts.fileKey, opts.nodeId, opts.format, opts.scale, opts.fileVersion].join('|'))
    .digest('hex');
}
```

`fileVersion` は Figma REST `/v1/files/:key?depth=1` の `lastModified` (ISO 文字列) を使う。

### 5.2 lookup

`SELECT * FROM assets WHERE created_by = $1 AND cache_key = $2 LIMIT 1`

ヒットなら新しい signed URL を発行 (storage path は変わらない) して返す。`audit_log` に `render.cache_hit` を 1 行追加。

### 5.3 miss

レンダリング → Storage upload → `INSERT INTO assets` → `audit_log` に `render.requested` / `render.completed` / `asset.download_url_issued` を順次追加。

### 5.4 force_refresh

`force_refresh: true` の場合は lookup をスキップして必ずレンダリング。既存 cache 行があれば**新規行を作らず**同じ cache_key 行を upsert する (unique 制約のため)。

## 6. Storage 規約

- バケット: `figma-assets`
- パス: `<userId>/<fileKey>/<nodeIdSafe>/<digest>.png`
  - `nodeIdSafe` = `nodeId.replace(':', '_')`
  - `digest` = upload bytes の sha256 先頭 16 文字 (cache_key とは別)
- TTL: `classification === 'confidential'` → 5 分、`internal` → 15 分 (assets.expires_at に反映)

## 7. JWT 検証 (Phase 3 範囲)

`Authorization: Bearer <jwt>` を Supabase `sb.auth.getUser(token)` で検証。成功時 `userId = data.user.id` を `c.set('userId', userId)`。

Phase 7 で API Key (fmps_) 対応を追加。

## 8. 環境変数 (worker)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FIGMA_TOKEN`, `PORT`(default 3000), `STORAGE_BUCKET`(default `figma-assets`), `SIGNED_URL_TTL_SEC`(default 300), `LOG_LEVEL`(default `info`)

## 9. ロギング

worker は `console.log` を普通に使ってよい (stdio 制約なし)。1 行 JSON で構造化:

```ts
console.log(JSON.stringify({
  ts: new Date().toISOString(),
  level: 'info',
  msg: 'render.completed',
  userId,
  fileKey,
  nodeId,
  cacheHit,
  durationMs,
}));
```
