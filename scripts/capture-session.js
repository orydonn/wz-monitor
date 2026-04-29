// Launch a headed Chromium, let the user log in to work-zilla.com,
// then save storageState.json next to the project.
//
// Usage: node scripts/capture-session.js [outputPath]

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const out = path.resolve(process.cwd(), process.argv[2] || 'storageState.json');
const url = 'https://client.work-zilla.com/freelancer';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'ru-RU',
});
const page = await context.newPage();
console.log('Opening', url, '— please log in if prompted.');
await page.goto(url, { waitUntil: 'domcontentloaded' });

console.log(
  '\nЛогинься в открывшемся окне. Когда попадёшь на /freelancer и увидишь свою ленту —',
  '\nвернись сюда и нажми Enter в этом терминале, чтобы сохранить сессию.\n',
);

process.stdin.setRawMode?.(true);
process.stdin.resume();
await new Promise((res) => process.stdin.once('data', () => res()));
process.stdin.setRawMode?.(false);
process.stdin.pause();

const current = page.url();
if (current.includes('/account/login')) {
  console.error('Похоже, ты ещё не залогинился (URL =', current, ').');
  console.error('Залогинься и перезапусти скрипт.');
  await browser.close();
  process.exit(1);
}

await context.storageState({ path: out });
console.log('Сохранил storageState →', out);
fs.chmodSync(out, 0o600);
await browser.close();
