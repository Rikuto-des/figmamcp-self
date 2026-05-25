/**
 * export-slides-pdf.ts
 *
 * docs/slides.html の全 8 スライドを PNG キャプチャして
 * docs/slides.pdf として出力する。
 *
 * 使い方:
 *   pnpm export-slides
 *
 * 追加 npm パッケージ不要（Playwright のみ使用）。
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '../../..');
const SLIDES_HTML = resolve(REPO_ROOT, 'docs/slides.html');
const OUT_PDF = resolve(REPO_ROOT, 'docs/slides.pdf');

const SLIDE_COUNT = 8;
const VP_W = 1600;
const VP_H = 900;

async function main() {
  console.log('🎬  slides.html →  slides.pdf');
  console.log(`    source : ${SLIDES_HTML}`);

  // ── Phase 1: スライドを 1 枚ずつスクリーンショット ──
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: VP_W, height: VP_H });

  await page.goto(`file://${SLIDES_HTML}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600); // アニメーション安定待ち

  const base64Slides: string[] = [];

  for (let i = 0; i < SLIDE_COUNT; i++) {
    if (i > 0) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(450); // トランジション完了待ち
    }
    const bytes = await page.screenshot({ type: 'png' });
    base64Slides.push(bytes.toString('base64'));
    process.stdout.write(`    captured  ${i + 1} / ${SLIDE_COUNT}\r`);
  }
  process.stdout.write('\n');

  await browser.close();

  // ── Phase 2: スクリーンショットを HTML ページに埋め込み PDF 化 ──
  const innerHtml = base64Slides
    .map(
      (b64, i) =>
        `<div class="page">\n` +
        `  <!-- Slide ${i + 1} -->\n` +
        `  <img src="data:image/png;base64,${b64}" width="${VP_W}" height="${VP_H}">\n` +
        `</div>`,
    )
    .join('\n');

  const wrapperHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: #000; width: ${VP_W}px; }
.page {
  width: ${VP_W}px;
  height: ${VP_H}px;
  display: block;
  overflow: hidden;
  page-break-after: always;
  break-after: page;
}
.page:last-child {
  page-break-after: avoid;
  break-after: avoid;
}
img { display: block; }
</style>
</head>
<body>
${innerHtml}
</body>
</html>`;

  const browser2 = await chromium.launch({ headless: true });
  const page2 = await browser2.newPage();
  await page2.setContent(wrapperHtml, { waitUntil: 'networkidle' });

  const pdfBytes = await page2.pdf({
    width: `${VP_W}px`,
    height: `${VP_H}px`,
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });

  await browser2.close();

  writeFileSync(OUT_PDF, pdfBytes);
  console.log(`✅  PDF saved → ${OUT_PDF}`);
  console.log(`    ${SLIDE_COUNT} slides · ${(pdfBytes.byteLength / 1024).toFixed(0)} KB`);
}

main().catch((err) => {
  console.error('❌ export failed:', err);
  process.exit(1);
});
