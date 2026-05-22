import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pLimit from 'p-limit';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { env } from './env.js';
import { log } from './logger.js';
import { nodeIdToUrlForm } from './url-parser.js';

const limit = pLimit(2);

// BrowserContext is a PersistentContext (launchPersistentContext) so there is
// no separate Browser object — the context IS the browser in this mode.
let contextPromise: Promise<BrowserContext> | null = null;
let persistentContext: BrowserContext | null = null;

export class RenderError extends Error {
  constructor(
    public code:
      | 'figma_unauthenticated'
      | 'playwright_timeout'
      | 'figma_node_not_found'
      | 'figma_render_failed'
      | 'internal_error',
    message: string,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

/**
 * Resolve the Chrome profile directory to use for Playwright.
 *
 * Priority:
 *  1. FIGMA_STATE_JSON env var → decode base64 JSON to a temp file and use
 *     it as storageState (deployment path: Fly.io secrets).
 *  2. FIGMA_PROFILE_DIR env var → absolute path to a persistent profile dir.
 *  3. Default: <FIGMA_STATE_PATH parent>/chrome-profile  (local dev path that
 *     `login-figma.ts` creates when it runs `launchPersistentContext`).
 *
 * Returns { mode: 'profile', profileDir } | { mode: 'storageState', stateFile }.
 */
async function resolveProfile(): Promise<
  | { mode: 'profile'; profileDir: string }
  | { mode: 'storageState'; stateFile: string }
> {
  const { FIGMA_STATE_JSON, FIGMA_STATE_PATH, FIGMA_PROFILE_DIR } = env();

  // --- Deployment path: base64-encoded storageState JSON in env var ---
  if (FIGMA_STATE_JSON) {
    const decoded = Buffer.from(FIGMA_STATE_JSON, 'base64').toString('utf-8');
    const tmpPath = path.join(os.tmpdir(), `figma-state-${process.pid}.json`);
    await fs.writeFile(tmpPath, decoded, { mode: 0o600 });
    return { mode: 'storageState', stateFile: tmpPath };
  }

  // --- Explicit profile dir override ---
  if (FIGMA_PROFILE_DIR) {
    try {
      await fs.access(FIGMA_PROFILE_DIR);
      return { mode: 'profile', profileDir: FIGMA_PROFILE_DIR };
    } catch {
      throw new RenderError(
        'figma_unauthenticated',
        `FIGMA_PROFILE_DIR not found: ${FIGMA_PROFILE_DIR}. Run \`pnpm login-figma\`.`,
      );
    }
  }

  // --- Local dev: use chrome-profile next to figma.json ---
  const stateDir = path.dirname(path.resolve(FIGMA_STATE_PATH));
  const profileDir = path.join(stateDir, 'chrome-profile');
  try {
    await fs.access(profileDir);
    return { mode: 'profile', profileDir };
  } catch {
    // Fall back to storageState (figma.json) if chrome-profile doesn't exist
    try {
      await fs.access(FIGMA_STATE_PATH);
      log.warn('render.fallback_to_storage_state', {
        reason: 'chrome-profile not found; using figma.json storageState',
        profileDir,
        stateFile: FIGMA_STATE_PATH,
      });
      return { mode: 'storageState', stateFile: FIGMA_STATE_PATH };
    } catch {
      throw new RenderError(
        'figma_unauthenticated',
        `Neither chrome-profile nor figma.json found in ${stateDir}. Run \`pnpm login-figma\`.`,
      );
    }
  }
}

// Map user-facing scale (1|2|3) → deviceScaleFactor for Playwright context.
// scale:1 → 2× (Retina), scale:2 → 2×, scale:3 → 3×
const SCALE_TO_DSF: Record<number, number> = { 1: 2, 2: 2, 3: 3 };

function contextOpts(deviceScaleFactor: number) {
  return {
    viewport: { width: 1920, height: 1080 } as const,
    deviceScaleFactor,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.178 Safari/537.36',
    locale: 'ja-JP',
  };
}

const COMMON_LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
];

// Cache one context per deviceScaleFactor (usually only one scale used at a time)
const contextPromises = new Map<number, Promise<BrowserContext>>();

async function getContext(dsf: number): Promise<BrowserContext> {
  if (contextPromises.has(dsf)) return contextPromises.get(dsf)!;
  const p = (async () => {
    const profile = await resolveProfile();

    let context: BrowserContext;
    if (profile.mode === 'profile') {
      // Use the same persistent Chrome profile that login-figma.ts created.
      // This carries Google OAuth cookies and all Figma session state faithfully.

      // Remove stale SingletonLock/Socket left by a crashed or force-killed Chrome.
      // Safe to delete when no process holds the lock (verified above).
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        await fs.unlink(path.join(profile.profileDir, f)).catch(() => undefined);
      }

      log.info('render.context_init', { mode: 'persistent_profile', profileDir: profile.profileDir, dsf });
      context = await chromium.launchPersistentContext(profile.profileDir, {
        headless: true,
        channel: 'chrome',
        ignoreDefaultArgs: ['--enable-automation'],
        args: COMMON_LAUNCH_ARGS,
        ...contextOpts(dsf),
      });
    } else {
      // Deployment path: storageState JSON
      log.info('render.context_init', { mode: 'storage_state', stateFile: profile.stateFile, dsf });
      const browser = await chromium.launch({
        headless: true,
        channel: 'chrome',
        ignoreDefaultArgs: ['--enable-automation'],
        args: COMMON_LAUNCH_ARGS,
      });
      context = await browser.newContext({
        storageState: profile.stateFile,
        ...contextOpts(dsf),
      });
    }

    // Remove webdriver flag that automation-detection scripts check
    await context.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => undefined });
    });

    persistentContext = context;
    return context;
  })();
  contextPromises.set(dsf, p);
  return p;
}

export async function isBrowserReady(): Promise<boolean> {
  return persistentContext !== null && persistentContext.browser()?.isConnected() !== false;
}

export interface RenderOpts {
  fileKey: string;
  nodeId: string; // colon form, e.g. "1:23"
  scale: number;
}

export interface RenderResult {
  bytes: Buffer;
  mimeType: 'image/png';
  width: number;
  height: number;
}

export async function renderNode(opts: RenderOpts): Promise<RenderResult> {
  return limit(() => renderInner(opts));
}

async function renderInner(opts: RenderOpts): Promise<RenderResult> {
  const url = `https://www.figma.com/design/${opts.fileKey}/_?node-id=${nodeIdToUrlForm(opts.nodeId)}`;
  const dsf = SCALE_TO_DSF[opts.scale] ?? 2;
  const context = await getContext(dsf);
  const page = await context.newPage();
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Brief pause to let redirects settle
    await page.waitForTimeout(2000);

    // Check for login redirect (includes ?login_at= query param Figma adds)
    if (page.url().includes('/login') || page.url().includes('?login_at=')) {
      throw new RenderError('figma_unauthenticated', 'redirected to login');
    }

    log.debug('render.page_after_nav', { url: page.url() });

    // Dismiss "Use desktop app / font" dialog if it appears (Escape or ✕ button)
    await dismissFigmaDialogs(page);

    // Debug: capture what's visible right after navigation
    if (process.env.RENDER_DEBUG === '1') {
      const debugBytes = await page.screenshot({ type: 'png', fullPage: false }).catch(() => null);
      if (debugBytes) {
        require('fs').writeFileSync('/tmp/figma-render-debug.png', debugBytes);
        log.warn('render.debug_screenshot', { path: '/tmp/figma-render-debug.png' });
      }
    }

    const canvas = await waitForCanvas(page);
    if (!canvas) {
      // Try to capture a debug screenshot for diagnostics even without RENDER_DEBUG
      const debugBytes = await page.screenshot({ type: 'png', fullPage: false }).catch(() => null);
      if (debugBytes) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync('/tmp/figma-render-timeout-debug.png', debugBytes);
        log.warn('render.timeout_debug_screenshot', { path: '/tmp/figma-render-timeout-debug.png', currentUrl: page.url() });
      }
      throw new RenderError('playwright_timeout', 'canvas did not appear in time');
    }

    // Dismiss any remaining dialogs after canvas appears.
    // Use click-only variant — Escape would deselect the auto-selected node
    // (from node-id in the URL), breaking Shift+1 "zoom to selection" below.
    await dismissDialogsByClick(page);

    // Hide the Figma UI (toolbars / sidebars) so the canvas area is maximised.
    // Two approaches in parallel — keyboard shortcut + CSS injection — for reliability.
    //   Ctrl+\ = toggle Hide UI in Figma Web (expands canvas to fill viewport)
    await page.keyboard.press('Control+Backslash').catch(() => undefined);
    await page.waitForTimeout(300);

    // CSS fallback: also force-hide panels in case Ctrl+\ didn't fire.
    await page
      .addStyleTag({
        content: `
          [data-testid="left-panel"], [data-testid="right-panel"],
          [data-testid="canvas-toolbar"],
          [class*="figma-toolbar"], [class*="ToolbarPanel"],
          [class*="navbar"], [class*="NavBar"],
          [class*="dialog"], [class*="modal"] {
            visibility: hidden !important;
          }
        `,
      })
      .catch(() => undefined);

    // Zoom to fit the *selected* node.
    // Shift+1 = "Zoom to fit selection" in Figma — works because the URL's
    // node-id param causes Figma to auto-select that frame on load.
    // (Shift+0 = fit entire page, which zooms out when many frames are present.)
    await page.keyboard.press('Shift+1').catch(() => undefined);
    await page.waitForTimeout(1500);

    // ── DOM snapshot to find W/H input selectors (dev-only) ─────────────────
    if (process.env.RENDER_DEBUG === '1') {
      const domSnap = await page.evaluate(() => {
        const allInputs = Array.from(document.querySelectorAll('input'));
        const propEl = document.querySelector('[class*="properties"]');
        const propInputs = propEl
          ? Array.from(propEl.querySelectorAll('input')).map((i) => ({
              value: i.value,
              aria: i.getAttribute('aria-label'),
              type: i.type,
            }))
          : [];
        const spans = Array.from(document.querySelectorAll('span, label, div'))
          .filter((el) => {
            const t = el.textContent?.trim() ?? '';
            return (t === 'W' || t === 'H' || t === 'X' || t === 'Y') && el.children.length === 0;
          })
          .slice(0, 8)
          .map((el) => ({
            tag: el.tagName,
            text: el.textContent?.trim(),
            parent: el.parentElement?.tagName,
            siblingInput: el.parentElement
              ? (el.parentElement.querySelector('input') as HTMLInputElement | null)?.value
              : null,
          }));
        return {
          totalInputs: allInputs.length,
          allInputDetails: allInputs.map((i) => ({
            value: i.value,
            aria: i.getAttribute('aria-label'),
            placeholder: i.placeholder,
            type: i.type,
          })),
          propEl: propEl ? propEl.tagName : null,
          propInputs,
          whSpans: spans,
        };
      }).catch(() => null);
      log.warn('render.debug_dom_snap', domSnap ?? { error: 'eval failed' });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Viewport auto-resize for better text legibility ───────────────────────
    // If the target node is a tall portrait frame (e.g. 576×3992), the default
    // 1920×1080 landscape viewport makes Figma zoom out to ≈0.27× → unreadable
    // text.  Reading the frame's W/H from the right-panel inputs (values are
    // accessible even when the panel is visibility:hidden) and resizing to a
    // portrait viewport lets Figma zoom in to ≈0.75×, giving crisp glyphs.
    const frameDims = await tryGetFrameDimsFromDOM(page);
    if (frameDims) {
      const currentVp = page.viewportSize()!;
      const { vpW, vpH } = calcOptimalViewport(frameDims);
      // Estimate current vs proposed zoom (canvas ≈ viewport after panels hidden)
      const currentZoom = Math.min(
        currentVp.width / frameDims.width,
        currentVp.height / frameDims.height,
      );
      const newZoom = Math.min(vpW / frameDims.width, vpH / frameDims.height);
      if (newZoom > currentZoom * 1.25) {
        log.info('render.viewport_resize', {
          frameW: frameDims.width,
          frameH: frameDims.height,
          vpW,
          vpH,
          zoomBefore: +currentZoom.toFixed(3),
          zoomAfter: +newZoom.toFixed(3),
        });
        await page.setViewportSize({ width: vpW, height: vpH });
        await page.waitForTimeout(500);
        await page.keyboard.press('Shift+0').catch(() => undefined);
        await page.waitForTimeout(1500);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // getBoundingClientRect() in-page is more reliable than Playwright's
    // boundingBox() for canvas elements that are sized via CSS transforms.
    // We pick the largest canvas on the page (= Figma design surface).
    const clip = await getCanvasClip(page);

    const vp = page.viewportSize()!;
    const bytes = await page.screenshot({
      type: 'png',
      // If canvas rect is valid use it; otherwise fall back to full viewport
      clip: clip ?? { x: 0, y: 0, width: vp.width, height: vp.height },
      timeout: 15_000,
    });

    const width = clip?.width ?? vp.width;
    const height = clip?.height ?? vp.height;

    log.info('render.completed', {
      fileKey: opts.fileKey,
      nodeId: opts.nodeId,
      durationMs: Date.now() - t0,
      width,
      height,
      clipSource: clip ? 'canvas' : 'viewport_fallback',
    });

    return {
      bytes,
      mimeType: 'image/png',
      width: Math.round(width),
      height: Math.round(height),
    };
  } catch (err) {
    if (err instanceof RenderError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Timeout')) throw new RenderError('playwright_timeout', msg);
    throw new RenderError('figma_render_failed', msg);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Dismiss Figma startup dialogs (desktop app prompt, font warning, etc.) */
async function dismissFigmaDialogs(page: Page): Promise<void> {
  // Try clicking "続行" / "Continue" button first
  const continueBtn = await page
    .$('button:has-text("続行"), button:has-text("Continue"), button:has-text("Skip")')
    .catch(() => null);
  if (continueBtn) {
    await continueBtn.click().catch(() => undefined);
    await page.waitForTimeout(300);
    return;
  }
  // Fall back to Escape
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);
}

/**
 * Dismiss dialogs using ONLY button clicks — never Escape.
 * Pressing Escape in Figma also deselects the current node, which would break
 * the subsequent Shift+1 "zoom to selection" shortcut.
 */
async function dismissDialogsByClick(page: Page): Promise<void> {
  const selectors = [
    // "Use desktop app?" prompt
    'button:has-text("続行")',
    'button:has-text("Continue in browser")',
    'button:has-text("Continue")',
    'button:has-text("Skip")',
    // Font prompt / missing font warning
    'button:has-text("OK")',
    'button:has-text("Got it")',
    // Generic close / × buttons inside dialogs
    '[role="dialog"] button[aria-label="Close"]',
    '[role="dialog"] button[aria-label="閉じる"]',
    '[role="alertdialog"] button',
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      await btn.click().catch(() => undefined);
      await page.waitForTimeout(200);
    }
  }
}

async function waitForCanvas(page: Page) {
  // Wait up to 30 s for any canvas; Figma's canvas has no stable data-testid in all versions
  const el = await page.waitForSelector('canvas', { timeout: 30_000 }).catch(() => null);
  return el;
}

/**
 * Evaluate getBoundingClientRect() inside the page for the largest canvas element.
 * This is more reliable than Playwright's boundingBox() for elements sized via
 * CSS transforms or WebGL contexts (as Figma uses).
 * Falls back to viewport rect if no large canvas is found after 15 retries.
 */
async function getCanvasClip(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const rect = await page
      .evaluate(() => {
        const canvases = Array.from(document.querySelectorAll('canvas'));
        let best: { x: number; y: number; width: number; height: number } | null = null;
        let bestArea = 0;
        for (const c of canvases) {
          const r = c.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea) {
            bestArea = area;
            best = { x: r.x, y: r.y, width: r.width, height: r.height };
          }
        }
        // Only return if the canvas has meaningful size (> 200x200 px)
        return best && best.width > 200 && best.height > 200 ? best : null;
      })
      .catch(() => null);

    if (rect) return rect;
    await page.waitForTimeout(1000);
  }
  return null; // caller will use viewport fallback
}

/**
 * Read the selected node's W and H from Figma's right-panel inputs.
 * CSS `visibility:hidden` on the panel does NOT affect `element.value`,
 * so this works even after we've injected the panel-hiding stylesheet.
 */
async function tryGetFrameDimsFromDOM(
  page: Page,
): Promise<{ width: number; height: number } | null> {
  return page
    .evaluate(() => {
      const numVal = (el: HTMLInputElement | null): number | null => {
        if (!el) return null;
        const v = parseFloat(el.value.replace(/,/g, '').trim());
        return v > 0 && v < 50_000 && isFinite(v) ? v : null;
      };

      // Strategy 1: inputs with aria-label "W" / "H" (Figma has used these historically)
      const wEl =
        document.querySelector<HTMLInputElement>('input[aria-label="W"]') ??
        document.querySelector<HTMLInputElement>('input[aria-label="Width"]');
      const hEl =
        document.querySelector<HTMLInputElement>('input[aria-label="H"]') ??
        document.querySelector<HTMLInputElement>('input[aria-label="Height"]');
      const w1 = numVal(wEl);
      const h1 = numVal(hEl);
      if (w1 && h1) return { width: w1, height: h1 };

      // Strategy 2: first two positive-integer inputs inside the right panel
      const panel = document.querySelector('[data-testid="right-panel"]');
      if (panel) {
        const dims: number[] = [];
        for (const el of Array.from(panel.querySelectorAll<HTMLInputElement>('input'))) {
          const raw = el.value.replace(/,/g, '').trim();
          // Accept only whole numbers (pixel dimensions are integers in Figma)
          if (/^\d+$/.test(raw)) {
            const v = parseInt(raw, 10);
            if (v > 0 && v < 50_000) {
              dims.push(v);
              if (dims.length === 2) break;
            }
          }
        }
        if (dims.length === 2) return { width: dims[0]!, height: dims[1]! };
      }

      return null;
    })
    .catch(() => null);
}

/**
 * Calculate an optimal viewport size that improves Figma's zoom factor for `frame`.
 *
 * Strategy: keep viewport WIDTH fixed at 1 920 px so Figma's sidebar layout
 * (left/right panels, toolbars) remains intact.  Only increase the HEIGHT to
 * accommodate tall portrait frames.
 *
 * Reference frame 576 × 3 992 (portrait):
 *   projectedH = 3992 × (1920/576) = 13 306 → capped to 2 000
 *   → viewport 1920 × 2 000  → Figma zoom ≈ 0.50×
 *   vs. default  1920 × 1080  → Figma zoom ≈ 0.27×
 */
function calcOptimalViewport(frame: { width: number; height: number }): {
  vpW: number;
  vpH: number;
} {
  const FIXED_W = 1_920; // keep width so Figma sidebar layout is unaffected
  const MAX_H = 2_000;   // caps effective PNG height at ≈6 000 px at dsf=3

  // Project frame onto the fixed viewport width, then cap to MAX_H
  const projectedH = Math.round(frame.height * (FIXED_W / frame.width));
  const vpH = Math.min(MAX_H, Math.max(1_080, projectedH));
  return { vpW: FIXED_W, vpH };
}

export async function shutdown(): Promise<void> {
  contextPromises.clear();
  if (persistentContext) {
    await persistentContext.close().catch(() => undefined);
    persistentContext = null;
  }
}
