# mcp-server 詳細スペック (Phase 4, stdio 版)

## 1. ツール仕様

### 1.1 `figma_get_screenshot`

**description (Copilot 自動発火の主要シグナル)**:

> Use this whenever the user pastes a figma.com URL or asks for a screenshot/image/rendering of a Figma node, component, screen, or frame. Returns a PNG image of the specified node so the model can see the design and produce code or analysis based on it. This is the canonical way to read a Figma design within this workspace.

**inputSchema**:
```ts
{
  figma_url?: string,                         // either this …
  file_key?: string, node_id?: string,        // … or these two
  format?: "png" | "jpg",                     // default "png"
  scale?: 1 | 2 | 3                           // default 2
}
```

**動作**:
1. (なければ) Supabase Auth で `signInWithPassword` → access_token を取得
2. worker `POST /render` に `Authorization: Bearer <token>` で渡す
3. レスポンスの `signed_url` を fetch して bytes 取得
4. bytes を base64 化し、MCP response の `content` で返す:
   ```ts
   { content: [
       { type: "image", data: <base64>, mimeType: "image/png" },
       { type: "text", text: JSON.stringify({ asset_id, width, height, cache_hit, file_key, node_id }) }
   ] }
   ```
5. エラー時は `{ content: [...], isError: true }`

### 1.2 `figma_get_node_info`

**description**:

> Returns structured JSON metadata (name, type, position, size, fills, text content, child layers, etc.) for a Figma node identified by URL or file_key + node_id. Use this alongside figma_get_screenshot when you need exact text, dimensions, or hierarchy to produce code.

**inputSchema**:
```ts
{
  figma_url?: string,
  file_key?: string, node_id?: string
}
```

**動作**:
- worker `POST /node-info` を叩いてレスポンスをそのまま text content として返す

## 2. 認証 (Supabase JWT)

- `POC_EMAIL` / `POC_PASSWORD` を `signInWithPassword` する
- access_token / refresh_token を `~/.config/figma-mcp-poc/session.json` (mode `0600`) に保存
- 起動時に既存トークン読み → expires_at が 60 秒以内なら refresh → ダメなら再ログイン
- `ensureAccessToken(): Promise<string>` を export

## 3. stdio 制約

- **stdout を絶対に汚さない**。`console.log` 全面禁止 (`grep -rn "console.log" packages/mcp-server/src/` が空であること)
- 全ログは `console.error` (stderr) または `MCP_LOG_FILE` (env var) で指定されたファイルに append
- `src/logger.ts` でこの規律を抽象化

## 4. Worker 呼び出し

- `WORKER_URL` (default `http://localhost:3000`) に fetch
- リトライ: 1 回 (ネットワーク系のみ)
- タイムアウト: 60 秒

## 5. エラーハンドリング

- worker から 4xx/5xx → MCP `isError: true` で `error_code` を text に含める
- ネットワーク失敗 → 1 回リトライ後にエラー

## 6. `.vscode/mcp.json` (stdio 版)

```jsonc
{
  "servers": {
    "figma-internal": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/packages/mcp-server/bin/mcp-server.js"],
      "env": {
        "WORKER_URL": "http://localhost:3000",
        "SUPABASE_URL": "${env:SUPABASE_URL}",
        "SUPABASE_ANON_KEY": "${env:SUPABASE_ANON_KEY}",
        "POC_EMAIL": "${env:POC_EMAIL}",
        "POC_PASSWORD": "${env:POC_PASSWORD}",
        "MCP_LOG_FILE": "/tmp/figma-mcp-poc.log"
      }
    }
  }
}
```

**注意**: ルートキーは `"servers"`、`"mcpServers"` ではない (VS Code 公式仕様)。

## 7. 環境変数

- `SUPABASE_URL` (必須)
- `SUPABASE_ANON_KEY` (必須) — service_role は**絶対に渡さない**
- `POC_EMAIL`, `POC_PASSWORD` (必須)
- `WORKER_URL` (任意、default `http://localhost:3000`)
- `MCP_LOG_FILE` (任意、stderr 以外にファイルログを残すとき)
