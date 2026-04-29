// One-shot helper: copy the running Playwright-MCP Chrome profile to a temporary
// dir, open it with vanilla Playwright (so file locks from the live MCP browser
// aren't an issue), and export storageState.json. Use this when you're already
// authenticated in the MCP browser (which Claude opened) and don't want to log in
// twice.
//
// Usage: node scripts/import-from-mcp-profile.js [profileSourceDir] [outputPath]

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const src = path.resolve(
  process.argv[2] ||
    path.join(os.homedir(), 'Library/Caches/ms-playwright/mcp-chrome-44bd45b'),
);
const out = path.resolve(process.cwd(), process.argv[3] || 'storageState.json');

if (!fs.existsSync(src)) {
  console.error('Profile dir not found:', src);
  process.exit(1);
}

// Copy the profile to a tmpdir to avoid lock conflicts with the live MCP browser.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-profile-'));
console.log('Copying profile', src, '→', tmp);

function copyDir(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    try {
      if (entry.isSymbolicLink()) {
        // skip
      } else if (entry.isDirectory()) {
        copyDir(s, d);
      } else if (entry.isFile()) {
        fs.copyFileSync(s, d);
      }
    } catch (e) {
      // Skip locked / unreadable files (e.g. SingletonLock, RunningChromeVersion)
    }
  }
}

copyDir(src, tmp);

// Remove lock-files that prevent Chrome from opening this profile.
for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.unlinkSync(path.join(tmp, lock)); } catch {}
}

console.log('Launching headless Chromium against the copied profile...');
const context = await chromium.launchPersistentContext(tmp, {
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});

// Visit the freelancer URL once to ensure cookies are populated for that domain.
const page = await context.newPage();
try {
  await page.goto('https://client.work-zilla.com/freelancer', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
} catch (e) {
  console.warn('navigation warning:', e?.message || e);
}

const url = page.url();
if (url.includes('/account/login')) {
  console.error('Profile is NOT authenticated (URL =', url, ')');
  console.error('Залогинься в MCP-браузере, потом запусти этот скрипт снова.');
  await context.close();
  process.exit(2);
}

await context.storageState({ path: out });
fs.chmodSync(out, 0o600);
console.log('Saved storageState →', out);

await context.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Done.');
