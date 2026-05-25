// Interactive Figma login: launches a real Chrome window (persistent profile so
// Google OAuth works), lets the user sign in, then saves storageState to
// .playwright-state/figma.json.
//
// Usage:  pnpm login-figma

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

const STATE_DIR = '.playwright-state';
const STATE_FILE = path.join(STATE_DIR, 'figma.json');
// Dedicated Chrome profile directory — keeps the user's main Chrome profile untouched.
const PROFILE_DIR = path.join(STATE_DIR, 'chrome-profile');

async function main() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  console.log('[login-figma] Launching Chrome with persistent profile (Google OAuth supported)...');

  // launchPersistentContext + ignoreDefaultArgs keeps Chrome from injecting the
  // "--enable-automation" flag that causes Google to block OAuth sign-in.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());

  console.log('[login-figma] Opening figma.com/login. Please sign in (Google OAuth works here).');
  await page.goto('https://www.figma.com/login', { waitUntil: 'domcontentloaded' });

  const rl = readline.createInterface({ input, output });
  await rl.question(
    '\n[login-figma] Once you can see your Figma files dashboard, press Enter here to save the session.\n> ',
  );
  rl.close();

  await context.storageState({ path: STATE_FILE });
  console.log(`[login-figma] Saved storage state to ${STATE_FILE} (chmod 0600)`);
  await fs.chmod(STATE_FILE, 0o600);

  await context.close();
  console.log('[login-figma] Done. You can now run `pnpm dev`.');
}

main().catch((err) => {
  console.error('[login-figma] Failed:', err);
  process.exit(1);
});
