import { chromium } from 'playwright';
import fs from 'node:fs';
import { config, log } from './config.js';
import { extractInPage } from './parse.js';

export class SessionExpiredError extends Error {
  constructor(currentUrl) {
    super('Session expired or unauthenticated; redirected to ' + currentUrl);
    this.name = 'SessionExpiredError';
  }
}

export class Scraper {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async start() {
    if (!fs.existsSync(config.storageStatePath)) {
      throw new Error(
        `storageState not found at ${config.storageStatePath}. ` +
        `Run "npm run capture" while logged in to create it.`,
      );
    }

    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    this.context = await this.browser.newContext({
      storageState: config.storageStatePath,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'ru-RU',
    });
    this.page = await this.context.newPage();

    log.info('Opening freelancer page', config.freelancerUrl);
    await this.page.goto(config.freelancerUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this._assertLoggedIn();
    await this._waitForFeed();
  }

  // Wait until React renders either order cards or the empty-state message.
  // Without this, a cold start can scrape an empty pre-hydration DOM and miss
  // tasks that ARE on the page.
  async _waitForFeed() {
    try {
      await this.page.waitForFunction(
        () => {
          if (location.pathname.startsWith('/account/login')) return true;
          const links = document.querySelectorAll('a[href^="/freelancer/"]');
          for (const a of links) {
            if (/^\/freelancer\/\d+/.test(a.getAttribute('href') || '')) return true;
          }
          const main = document.querySelector('main');
          if (main && /Что-то нет подходящих|нет подходящих заданий/.test(main.textContent || '')) {
            return true;
          }
          return false;
        },
        { timeout: 15_000, polling: 500 },
      );
    } catch {
      log.warn('feed did not render within 15s — scraping anyway');
    }
  }

  async _assertLoggedIn() {
    const url = this.page.url();
    if (url.includes('/account/login')) throw new SessionExpiredError(url);
  }

  async refresh() {
    if (!this.page) throw new Error('Scraper not started');
    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (e) {
      log.warn('reload failed:', e?.message || e);
    }
    await this._assertLoggedIn();
    await this._waitForFeed();
  }

  async scrapeTasks() {
    if (!this.page) throw new Error('Scraper not started');
    await this._assertLoggedIn();
    const tasks = await this.page.evaluate(extractInPage);
    log.debug('extracted', tasks.length, 'task(s) from DOM');
    return tasks;
  }

  async saveSession() {
    if (!this.context) return;
    try {
      await this.context.storageState({ path: config.storageStatePath });
    } catch (e) {
      log.warn('saveSession failed:', e?.message || e);
    }
  }

  async close() {
    try { await this.context?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.page = this.context = this.browser = null;
  }
}
