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

    // Dismiss "Use desktop app / font" dialog if it appears (click-only — no Escape)
    await dismissDialogsByClick(page);

    // Debug: capture what's visible right after navigation
    if (process.env.RENDER_DEBUG === '1') {
      const debugBytes = await page.screenshot({ type: 'png', fullPage: false }).catch(() => null);
      if (debugBytes) {
        const { writeFileSync: wfs } = await import('node:fs');
        wfs('/tmp/figma-render-debug-nav.png', debugBytes);
        log.warn('render.debug_screenshot_nav', { path: '/tmp/figma-render-debug-nav.png' });
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
    // (from node-id in the URL), breaking Shift+2 "zoom to selection" below.
    await dismissDialogsByClick(page);

    // Extra wait for Figma to fully initialize the design and register the node
    // selection from the URL's ?node-id= parameter. The canvas element appears
    // before the selection state is fully committed; skimping here causes Shift+2
    // to zoom to "nothing selected" → shows the whole page instead of the node.
    await page.waitForTimeout(3000);
    log.info('render.canvas_ready', { fileKey: opts.fileKey, nodeId: opts.nodeId });

    // Move mouse to viewport center to give hover focus.
    // hover (no click) = no selection change; mouse presence activates
    // Figma's keyboard event handler without disturbing the auto-selected node.
    const vpCenter = page.viewportSize() ?? { width: 1920, height: 1080 };
    await page.mouse.move(vpCenter.width / 2, vpCenter.height / 2);

    // Ensure the page (not the browser chrome) has OS-level keyboard focus.
    await page.bringToFront();
    await page.waitForTimeout(200);

    // ── Step 1: Zoom to fit the selected node ────────────────────────────────
    // Shift+2 = "Zoom to Fit Selection" in Figma (zoom INTO the selected node).
    // Shift+1 = "Zoom to Fit Page" (shows ALL frames — NOT what we want here).
    //
    // The target node is already selected because the URL carries ?node-id=X-Y
    // which Figma auto-selects on load.
    //
    // IMPORTANT: do this BEFORE hiding the UI — Figma's keyboard handler is
    // fully active while the normal interface is visible.
    log.info('render.zoom_to_selection', { shortcut: 'Shift+2' });
    await page.keyboard.press('Shift+2').catch(() => undefined);
    await page.waitForTimeout(2000); // wait for zoom animation to complete

    if (process.env.RENDER_DEBUG === '1') {
      const { writeFileSync: wfs } = await import('node:fs');
      const b = await page.screenshot({ type: 'png' }).catch(() => null);
      if (b) { wfs('/tmp/figma-debug-after-shift2.png', b); log.warn('render.debug_after_shift2', { path: '/tmp/figma-debug-after-shift2.png', url: page.url() }); }
    }

    // ── Step 2: Hide Figma UI chrome ─────────────────────────────────────────
    // Strategy A: keyboard shortcuts
    //   Meta+\ = Cmd+\ on Mac (hides left/right panels in Figma)
    //   Control+\ = Ctrl+\ (also tried for completeness)
    log.info('render.hide_ui_start');
    await page.keyboard.press('Meta+\\').catch(() => undefined);
    await page.waitForTimeout(400);
    await page.keyboard.press('Control+\\').catch(() => undefined);
    await page.waitForTimeout(400);

    // Strategy B: JavaScript-based hiding.
    //
    // Figma obfuscates its CSS class names (e.g. "left_panel_container--sizeContainer--Lqb7I"),
    // so CSS class-name selectors are unreliable. Instead we:
    //   1. Use document.elementsFromPoint() to probe what's RENDERED at the top/bottom
    //      edge of the screen and hide those elements.
    //   2. Hide the known left-panel by its stable ID.
    //   3. Hide any element that is position:fixed (overlay panels, floating toolbars).
    //
    // Note: We operate on VISIBILITY (not display) so layout is preserved and the
    // zoom from Shift+2 is not disturbed.
    const hideResult = await page.evaluate(() => {
      const hidden: string[] = [];

      // ── Helper: hide an element and record it ──────────────────────────────
      function hideEl(el: Element, reason: string) {
        if (el === document.documentElement || el === document.body) return;
        if (el.tagName === 'CANVAS') return; // never hide the design canvas
        (el as HTMLElement).style.setProperty('visibility', 'hidden', 'important');
        hidden.push(`${reason}:${el.tagName}#${el.id.slice(0,20)}.${(el as HTMLElement).className.slice(0,40)}`);
      }

      // ── 1. Probe elements at top edge (y = 1 and y = 30) ──────────────────
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      for (const probeY of [1, 20, 35]) {
        for (const el of document.elementsFromPoint(vw / 2, probeY)) {
          const r = (el as HTMLElement).getBoundingClientRect();
          // Only hide thin bar-like elements (toolbar height 20–80px) near the top
          if (r.height > 10 && r.height < 100 && r.top >= -5 && r.top <= 10) {
            hideEl(el, `top-probe-y${probeY}`);
          }
        }
      }

      // ── 2. Probe elements at bottom edge ──────────────────────────────────
      for (const probeY of [vh - 1, vh - 25, vh - 40]) {
        for (const el of document.elementsFromPoint(vw / 2, probeY)) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.height > 10 && r.height < 100 && r.bottom <= vh + 5 && r.bottom >= vh - 100) {
            hideEl(el, `bottom-probe-y${probeY}`);
          }
        }
      }

      // ── 3. Hide left panel by stable ID ───────────────────────────────────
      const leftPanel = document.getElementById('left-panel-container');
      if (leftPanel) hideEl(leftPanel, 'left-panel-id');

      // ── 4. Hide right panel (probe x = vw - 10) ───────────────────────────
      for (const el of document.elementsFromPoint(vw - 10, vh / 2)) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 50 && r.width < 400 && r.right >= vw - 10) {
          hideEl(el, 'right-panel-probe');
        }
      }

      // ── 5. Hide ALL position:fixed elements (floating panels, menus) ───────
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (el.tagName === 'CANVAS') continue;
        const style = window.getComputedStyle(el);
        if (style.position === 'fixed') {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 50 && r.height > 10) {
            hideEl(el, 'fixed-pos');
          }
        }
      }

      return { hiddenCount: hidden.length, items: hidden.slice(0, 20) };
    }).catch(() => ({ hiddenCount: 0, items: [] }));

    log.info('render.hide_ui_done', {
      hiddenCount: hideResult.hiddenCount,
      items: hideResult.items,
    });
    await page.waitForTimeout(300);

    if (process.env.RENDER_DEBUG === '1') {
      const { writeFileSync: wfs } = await import('node:fs');
      const b = await page.screenshot({ type: 'png' }).catch(() => null);
      if (b) { wfs('/tmp/figma-debug-after-hide.png', b); log.warn('render.debug_after_hide', { path: '/tmp/figma-debug-after-hide.png' }); }

      // DOM structure inspection
      const domInfo = await page.evaluate(() => {
        const canvases = Array.from(document.querySelectorAll('canvas'));
        const largest = canvases.reduce<HTMLCanvasElement | null>((best, c) => {
          const r = c.getBoundingClientRect();
          const area = r.width * r.height;
          const bestArea = best ? (() => { const b2 = best.getBoundingClientRect(); return b2.width * b2.height; })() : 0;
          return area > bestArea ? c : best;
        }, null);
        const canvasRect = largest ? largest.getBoundingClientRect() : null;

        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Probe top edge — find what's visually rendered at top of screen
        // (width > 100 to avoid tiny icon elements)
        const topBars = Array.from(document.querySelectorAll('*'))
          .filter(el => {
            const r = (el as HTMLElement).getBoundingClientRect();
            // Use a broad filter: any element near the top with meaningful width
            return r.top >= -5 && r.top < 60 && r.height > 10 && r.height < 120 && r.width > 100;
          })
          .slice(0, 15)
          .map(el => ({
            tag: el.tagName,
            id: el.id.slice(0, 40),
            cls: (el as HTMLElement).className.slice(0, 80),
            rect: (el as HTMLElement).getBoundingClientRect(),
            vis: window.getComputedStyle(el).visibility,
          }));

        // Probe bottom edge
        const bottomBars = Array.from(document.querySelectorAll('*'))
          .filter(el => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return r.bottom > vh - 80 && r.bottom <= vh + 5 && r.height > 10 && r.height < 100 && r.width > 100;
          })
          .slice(0, 10)
          .map(el => ({
            tag: el.tagName,
            id: el.id.slice(0, 40),
            cls: (el as HTMLElement).className.slice(0, 80),
            rect: (el as HTMLElement).getBoundingClientRect(),
            vis: window.getComputedStyle(el).visibility,
          }));

        // elementsFromPoint at exact corners / edges
        const probePoints = [
          { label: 'top-center', x: vw/2, y: 5 },
          { label: 'top-left',   x: 50,   y: 5 },
          { label: 'bot-center', x: vw/2, y: vh - 5 },
          { label: 'left-mid',   x: 10,   y: vh/2 },
        ];
        const probeResults = probePoints.map(pt => ({
          ...pt,
          elements: document.elementsFromPoint(pt.x, pt.y)
            .slice(0, 4)
            .map(el => ({
              tag: el.tagName,
              id: el.id.slice(0,20),
              vis: window.getComputedStyle(el).visibility,
              rect: (el as HTMLElement).getBoundingClientRect(),
            })),
        }));

        return { canvasRect, topBars, bottomBars, probeResults, vw, vh };
      }).catch(() => null);
      log.warn('render.dom_info', domInfo ?? { error: 'eval failed' });
    }

    // ── Step 3: Deselect to remove selection highlight ───────────────────────
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(400);

    if (process.env.RENDER_DEBUG === '1') {
      const { writeFileSync: wfs } = await import('node:fs');
      const b = await page.screenshot({ type: 'png' }).catch(() => null);
      if (b) { wfs('/tmp/figma-debug-after-esc.png', b); log.warn('render.debug_after_esc', { path: '/tmp/figma-debug-after-esc.png' }); }
    }

    // getBoundingClientRect() in-page is more reliable than Playwright's
    // boundingBox() for canvas elements that are sized via CSS transforms.
    // We pick the largest canvas on the page (= Figma design surface).
    const clip = await getCanvasClip(page);
    log.info('render.canvas_clip', { clip });

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
      hiddenElements: hideResult.hiddenCount,
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

export async function shutdown(): Promise<void> {
  contextPromises.clear();
  if (persistentContext) {
    await persistentContext.close().catch(() => undefined);
    persistentContext = null;
  }
}
