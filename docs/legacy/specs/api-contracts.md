# API 契約 (worker / mcp 共通)

Phase 3 の renderer-worker、Phase 4 の mcp-server の両方で参照する HTTP API 仕様。Phase 7 では同じ payload を MCP tool input/output として再利用する。

すべて JSON over HTTPS。Content-Type は `application/json`。`Authorization: Bearer <JWT>` または Phase 7 では `Bearer fmps_xxx` (API Key)。

---

## 1. `POST /render`

Figma URL からスクリーンショットを生成 (またはキャッシュから返す) し、Supabase Storage の signed URL を返す。

### Request body

| field | type | required | default | 備考 |
|---|---|---|---|---|
| `figma_url` | string | (どちらか) | — | `https://www.figma.com/design/...?node-id=...` |
| `file_key` | string | (どちらか) | — | URL の代わりに `file_key` + `node_id` 直接指定 |
| `node_id` | string | `file_key` 指定時 | — | `1:23` 形式 (内部表現) もしくは `1-23` (URL 形式) |
| `format` | `"png" \| "jpg"` | no | `"png"` | |
| `scale` | `1 \| 2 \| 3` | no | `2` | |
| `force_refresh` | boolean | no | `false` | true なら cache を無視して再レンダリング |
| `classification` | `"internal" \| "confidential"` | no | `"internal"` | TTL 計算に使用 |

例:
```json
{
  "figma_url": "https://www.figma.com/design/abc123/Test?node-id=1-23",
  "scale": 2,
  "classification": "internal"
}
```

### Response 200

```ts
{
  asset_id: string;              // uuid
  signed_url: string;            // https://<project>.supabase.co/storage/v1/object/sign/...
  signed_url_expires_at: string; // ISO8601
  cache_hit: boolean;
  rendered_via: "cache" | "playwright";
  width: number;
  height: number;
  format: "png" | "jpg";
  scale: 1 | 2 | 3;
  classification: "internal" | "confidential";
  tier: "A" | "B" | "C";         // PoC は基本 "B" (Playwright)
  file_key: string;
  node_id: string;               // 正規化済み (`1:23` 形式)
}
```

### Error responses

| HTTP | code (in body) | 意味 |
|---|---|---|
| 400 | `invalid_request` | body validation 失敗 / URL パース失敗 |
| 401 | `unauthorized` | JWT/API Key 欠落・無効 |
| 403 | `forbidden` | (PoC では未使用、将来用) |
| 404 | `figma_node_not_found` | Figma で node が見つからない |
| 422 | `figma_render_failed` | Playwright がレンダリング失敗 |
| 422 | `figma_unauthenticated` | Figma ログイン切れ (storageState 期限) |
| 504 | `playwright_timeout` | レンダリング タイムアウト (default 30s) |
| 500 | `internal_error` | その他 |

Error body shape:
```ts
{ error: { code: string; message: string } }
```

---

## 2. `POST /node-info`

Figma REST `/v1/files/:key/nodes?ids=...` のプロキシ。構造情報 (テキスト、サイズ、色など) を JSON で返す。

### Request body

| field | type | required | 備考 |
|---|---|---|---|
| `figma_url` | string | (どちらか) | |
| `file_key` | string | (どちらか) | |
| `node_id` | string | `file_key` 指定時 | |

### Response 200

```ts
{
  file_key: string;
  node_id: string;
  node: {
    id: string;
    name: string;
    type: string;                 // "FRAME" | "COMPONENT" | "INSTANCE" | ...
    absoluteBoundingBox: { x: number; y: number; width: number; height: number };
    children?: Array<unknown>;    // Figma node 構造そのまま (depth=1)
    // ... Figma API レスポンスを概ね pass-through
  };
}
```

### Errors
`POST /render` と同じスキーマ。`figma_node_not_found` (404) と `unauthorized` (401) を主に返す。

---

## 3. `GET /healthz`

ヘルスチェック。認証不要。

### Response 200

```ts
{
  status: "ok" | "degraded";
  browser_ready: boolean;     // Playwright context 起動済みか
  uptime_sec: number;
  version: string;            // package.json から
}
```

---

## 4. Phase 7 追加: `POST/GET/DELETE /mcp`

`@modelcontextprotocol/sdk` の `StreamableHTTPServerTransport` 経由で MCP プロトコル (JSON-RPC) を扱う。詳細は `docs/specs/remote-mcp-spec.md` を参照。

- 認証: `Authorization: Bearer <fmps_xxx | JWT>`
- セッション: `Mcp-Session-Id` ヘッダで管理 (新規セッションはサーバーが ID を生成して返す)

---

## 5. 共通ヘッダ

| Header | 用途 |
|---|---|
| `Authorization: Bearer <token>` | 必須 (`/healthz` 除く) |
| `Content-Type: application/json` | 必須 (POST 系) |
| `Mcp-Session-Id: <uuid>` | Phase 7 の `/mcp` のみ |

## 6. zod スキーマ対応

`packages/renderer-worker/src/routes/render.ts` (および後続 `figma-mcp-service`) では zod でこれらを validate する。`packages/shared/src/api.ts` に TS interface のみ定義し、zod schema は worker 側で生成する (型は `z.infer<typeof Schema>` で再エクスポート可能)。
