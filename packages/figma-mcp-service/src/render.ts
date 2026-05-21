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

let browser: Browser | null = null;
let contextPromise: Promise<BrowserContext> | null = null;
let storageStatePath: string | null = null;

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

async function resolveStorageStatePath(): Promise<string> {
  if (storageStatePath) return storageStatePath;
  const fromEnv = env().FIGMA_STATE_JSON;
  if (fromEnv) {
    const decoded = Buffer.from(fromEnv, 'base64').toString('utf-8');
    const tmpPath = path.join(os.tmpdir(), `figma-state-${process.pid}.json`);
    await fs.writeFile(tmpPath, decoded, { mode: 0o600 });
    storageStatePath = tmpPath;
  } else {
    storageStatePath = env().FIGMA_STATE_PATH;
    try {
      await fs.access(storageStatePath);
    } catch {
      throw new RenderError(
        'figma_unauthenticated',
        `Figma storageState file not found at ${storageStatePath}. Run \`pnpm login-figma\`.`,
      );
    }
  }
  return storageStatePath;
}

async function getContext(): Promise<BrowserContext> {
  if (contextPromise) return contextPromise;
  contextPromise = (async () => {
    const stateFile = await resolveStorageStatePath();
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome', // use system Chrome (avoids separate playwright chromium download)
      // ignoreDefaultArgs removes --enable-automation which triggers CloudFront bot detection
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    const context = await browser.newContext({
      storageState: stateFile,
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      // Spoof a real non-headless Chrome UA to bypass CloudFront bot detection
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.178 Safari/537.36',
      locale: 'ja-JP',
    });
    // Remove webdriver flag that automation-detection scripts check
    await context.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => undefined });
    });
    return context;
  })();
  return contextPromise;
}

export async function isBrowserReady(): Promise<boolean> {
  return browser !== null && browser.isConnected();
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait for either login redirect or canvas
    if (page.url().includes('/login') || page.url().includes('?login_at=')) {
      throw new RenderError('figma_unauthenticated', 'redirected to login');
    }

    // Dismiss "Use desktop app / font" dialog if it appears (Escape or ✕ button)
    await dismissFigmaDialogs(page);

    const canvas = await waitForCanvas(page);
    if (!canvas) {
      throw new RenderError('playwright_timeout', 'canvas did not appear in time');
    }

    // Dismiss any remaining dialogs after canvas appears
    await dismissFigmaDialogs(page);

    // Hide side panels and toolbar for a cleaner shot.
    await page
      .addStyleTag({
        content: `
          [data-testid="left-panel"], [data-testid="right-panel"],
          [data-testid="canvas-toolbar"], [class*="toolbar"],
          [class*="dialog"], [class*="modal"] {
            visibility: hidden !important;
          }
        `,
      })
      .catch(() => undefined);

    // Zoom to selection (URL with node-id pre-selects the node).
    await page.keyboard.press('Escape').catch(() => undefined); // close any lingering dialog
    await page.waitForTimeout(300);
    await page.keyboard.press('Shift+1').catch(() => undefined);
    await page.waitForTimeout(1000);

    const box = await canvas.boundingBox();
    if (!box) throw new RenderError('figma_render_failed', 'canvas bounding box not available');

    const bytes = await page.screenshot({
      type: 'png',
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
      timeout: 15_000,
    });

    log.info('render.completed', {
      fileKey: opts.fileKey,
      nodeId: opts.nodeId,
      durationMs: Date.now() - t0,
      width: box.width,
      height: box.height,
    });

    return {
      bytes,
      mimeType: 'image/png',
      width: Math.round(box.width),
      height: Math.round(box.height),
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
  // Wait up to 20 s for any canvas; Figma's canvas has no stable data-testid in all versions
  const el = await page.waitForSelector('canvas', { timeout: 20_000 }).catch(() => null);
  return el;
}

export async function shutdown(): Promise<void> {
  contextPromise = null;
  if (browser) {
    await browser.close().catch(() => undefined);
    browser = null;
  }
}
