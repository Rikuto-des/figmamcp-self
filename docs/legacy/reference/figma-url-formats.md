# Figma URL フォーマット仕様

## 1. 対応する URL パターン

Figma の「Copy link to selection」と「Copy link」、および手動コピーで得られる URL を吸収する。

```
https://www.figma.com/{kind}/{fileKey}/{name}[?node-id={nodeId}]
                       ^^^^^^
              design | file | proto | board | slides | community/file
```

`fileKey` は 22 文字前後の英数字。`name` は URL-encoded のタイトル (空でも可)。

### 1.1 例

| 入力 URL | fileKey | nodeId (正規化後) |
|---|---|---|
| `https://www.figma.com/design/abc123XYZ/My-Mockup?node-id=1-23` | `abc123XYZ` | `1:23` |
| `https://www.figma.com/design/abc123XYZ/My-Mockup?node-id=1:23` | `abc123XYZ` | `1:23` |
| `https://www.figma.com/design/abc123XYZ/My-Mockup` | `abc123XYZ` | (null = ファイルルート) |
| `https://www.figma.com/file/abc123XYZ/Legacy?node-id=10-5` | `abc123XYZ` | `10:5` |
| `https://www.figma.com/proto/abc123XYZ/Proto?node-id=2-34&type=design` | `abc123XYZ` | `2:34` |
| `https://www.figma.com/board/abc123XYZ/Whiteboard?node-id=0-1` | `abc123XYZ` | `0:1` |
| `https://figma.com/design/abc123XYZ/foo?node-id=1-2` | `abc123XYZ` | `1:2` |
| `figma.com/design/abc123XYZ/?node-id=1-2` (scheme なし) | `abc123XYZ` | `1:2` |
| `https://www.figma.com/design/abc123XYZ/Test?something=else&node-id=99-100` | `abc123XYZ` | `99:100` |
| `not-a-figma-url` | null (パース失敗) | — |

## 2. nodeId 正規化ルール

Figma のクエリ `node-id=X-Y` は内部表現 `X:Y` のハイフン置換版。本実装では:

- 入力受領時: `-` → `:` 変換 (`1-23` → `1:23`)
- DB/API レスポンスでは `:` 形式で扱う
- 公式 REST API (`/v1/files/:key/nodes?ids=X:Y`) は `:` を要求

## 3. URL フラグメントとクエリ

- `#`-fragment は無視 (例: `...?node-id=1-2#abc`)
- 他のクエリパラメータ (`type`, `viewport`, `t`, etc.) は無視
- `node-id` が複数指定 (`node-id=1-2&node-id=3-4`) の場合は最初のもの

## 4. エラー

- `fileKey` が抽出できない → `parseFigmaUrl` は `null` を返す
- `node-id` がなくても OK (ファイルルート扱い、後段でデフォルト挙動)

## 5. パーサ仕様 (`parseFigmaUrl`)

```ts
interface ParsedFigmaUrl {
  fileKey: string;
  nodeId: string | null; // null = ファイルルート
}

export function parseFigmaUrl(url: string): ParsedFigmaUrl | null;
```

実装ヒント:
```ts
// 1. URL クラスで parse を試みる (scheme なしは https を付与)
const u = new URL(input.startsWith('http') ? input : `https://${input}`);
if (!/(^|\.)figma\.com$/.test(u.hostname)) return null;

// 2. パスから kind / fileKey 抽出
//    /(design|file|proto|board|slides|community\/file)/([A-Za-z0-9]+)(\/.*)?/
const m = u.pathname.match(/^\/(design|file|proto|board|slides|community\/file)\/([A-Za-z0-9]+)/);
if (!m) return null;

// 3. node-id を正規化
const raw = u.searchParams.get('node-id');
const nodeId = raw ? raw.replace(/-/g, ':') : null;

return { fileKey: m[2], nodeId };
```

## 6. テストケース (vitest)

`packages/renderer-worker/src/url-parser.test.ts` で上記 §1.1 の全行 + 異常系数件を網羅。
