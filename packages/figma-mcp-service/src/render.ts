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

const COMMON_CONTEXT_OPTS = {
  viewport: { width: 1920, height: 1080 } as const,
  deviceScaleFactor: 2,
  // Spoof a real non-headless Chrome UA to bypass bot detection
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.178 Safari/537.36',
  locale: 'ja-JP',
};

const COMMON_LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
];

async function getContext(): Promise<BrowserContext> {
  if (contextPromise) return contextPromise;
  contextPromise = (async () => {
    const profile = await resolveProfile();

    let context: BrowserContext;
    if (profile.mode === 'profile') {
      // Use the same persistent Chrome profile that login-figma.ts created.
      // This carries Google OAuth cookies and all Figma session state faithfully.
      log.info('render.context_init', { mode: 'persistent_profile', profileDir: profile.profileDir });
      context = await chromium.launchPersistentContext(profile.profileDir, {
        headless: true,
        channel: 'chrome',
        ignoreDefaultArgs: ['--enable-automation'],
        args: COMMON_LAUNCH_ARGS,
        ...COMMON_CONTEXT_OPTS,
      });
    } else {
      // Deployment path: storageState JSON
      log.info('render.context_init', { mode: 'storage_state', stateFile: profile.stateFile });
      const browser = await chromium.launch({
        headless: true,
        channel: 'chrome',
        ignoreDefaultArgs: ['--enable-automation'],
        args: COMMON_LAUNCH_ARGS,
      });
      context = await browser.newContext({
        storageState: profile.stateFile,
        ...COMMON_CONTEXT_OPTS,
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
  return contextPromise;
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
  const context = await getContext();
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

    // Dismiss any remaining dialogs after canvas appears
    await dismissFigmaDialogs(page);

    // Hide side panels and toolbar for a cleaner shot.
    // NOTE: avoid broad [class*="toolbar"] which can match the canvas container.
    await page
      .addStyleTag({
        content: `
          [data-testid="left-panel"], [data-testid="right-panel"],
          [data-testid="canvas-toolbar"],
          [class*="figma-toolbar"], [class*="ToolbarPanel"],
          [class*="dialog"], [class*="modal"] {
            visibility: hidden !important;
          }
        `,
      })
      .catch(() => undefined);

    // Zoom to fit the selected node (Shift+0 = "Zoom to Fit Selection" in Figma).
    await page.keyboard.press('Escape').catch(() => undefined); // close any lingering dialog
    await page.waitForTimeout(300);
    await page.keyboard.press('Shift+0').catch(() => undefined);
    await page.waitForTimeout(1500);

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
  contextPromise = null;
  if (persistentContext) {
    await persistentContext.close().catch(() => undefined);
    persistentContext = null;
  }
}
