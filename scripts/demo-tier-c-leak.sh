#!/usr/bin/env bash
# =============================================================================
# Tier C 脅威確認スクリプト (Phase 6 — ガバナンス審査エビデンス用)
#
# 目的: Figma 公式 /v1/images が返す URL は公開 S3 上にあり、認証ヘッダなしで
#       誰でも GET できることを示す。本実装が /v1/images を使わない理由の根拠。
#
# 必要な環境変数:
#   FIGMA_TOKEN     ... Figma PAT
#   FIGMA_FILE_KEY  ... 個人 Figma の検証用ファイル key
#   FIGMA_NODE_ID   ... 同 node id (e.g. 1:23)
#
# Usage:
#   chmod +x scripts/demo-tier-c-leak.sh
#   FIGMA_TOKEN=figd_... FIGMA_FILE_KEY=abc FIGMA_NODE_ID=1:23 \
#     ./scripts/demo-tier-c-leak.sh
# =============================================================================

set -euo pipefail

: "${FIGMA_TOKEN:?missing FIGMA_TOKEN}"
: "${FIGMA_FILE_KEY:?missing FIGMA_FILE_KEY}"
: "${FIGMA_NODE_ID:?missing FIGMA_NODE_ID}"

echo "=== Step 1: Figma /v1/images で署名なし公開 S3 URL を発行 ==="
RESP=$(curl -s -H "X-Figma-Token: $FIGMA_TOKEN" \
  "https://api.figma.com/v1/images/${FIGMA_FILE_KEY}?ids=${FIGMA_NODE_ID}&format=png&scale=2")
echo "$RESP" | python3 -m json.tool || echo "$RESP"

S3_URL=$(echo "$RESP" | python3 -c "import sys, json; d=json.load(sys.stdin); print(next(iter(d['images'].values())))")

if [ -z "$S3_URL" ] || [ "$S3_URL" = "None" ]; then
  echo "FAIL: could not extract S3 URL"
  exit 1
fi

echo ""
echo "=== Step 2: 同じ URL を Authorization ヘッダなしで GET ==="
echo "URL: $S3_URL"
STATUS=$(curl -s -o /tmp/figma-leak.png -w "%{http_code}" "$S3_URL")

echo "HTTP status: $STATUS"
if [ "$STATUS" = "200" ]; then
  echo "PNG size: $(wc -c < /tmp/figma-leak.png) bytes"
  echo ""
  echo "*** CONFIRMED: /v1/images が返す URL は認証なしで誰でもアクセス可能 ***"
  echo "    これがガバナンスで禁止される理由。"
  echo "    本実装 (renderer-worker / figma-mcp-service) はこの経路を使わず、"
  echo "    private Supabase Storage + 短寿命 signed URL に置き換えている。"
else
  echo "Unexpected status: $STATUS"
  exit 1
fi
