import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { config, log } from './config.js';
import { extractInPage, extractTaskDetailInPage, extractInboxInPage, extractChatInPage } from './parse.js';

function findHeadlessShell() {
  try {
    const base = path.join(process.env.HOME || '/root', '.cache', 'ms-playwright');
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-'));
    if (!dirs.length) return undefined;
    dirs.sort().reverse();
    const candidate = path.join(base, dirs[0], 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch { return undefined; }
}

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

    // Use headless-shell when available — full Chrome hangs in WSL on external resources
    const executablePath = findHeadlessShell() || undefined;
    this.browser = await chromium.launch({
      executablePath,
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

  /**
   * Open a single task's detail page, scrape full description / files / client,
   * then return to the main feed so the polling loop is unaffected.
   * @param {string} taskId
   * @returns {Promise<{id:string, title:string, description:string,
   *                   files:Array<{name:string,url:string}>, client:string}>}
   */
  async openTaskDetail(taskId) {
    if (!this.page) throw new Error('Scraper not started');
    const detailUrl = `https://client.work-zilla.com/freelancer/${taskId}`;
    log.debug('opening detail', taskId);
    try {
      await this.page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (e) {
      log.warn('detail goto failed:', e?.message || e);
    }
    await this._assertLoggedIn();

    // Wait until React renders the detail (description text, h1)
    try {
      await this.page.waitForFunction(
        () => {
          if (location.pathname.startsWith('/account/login')) return true;
          const main = document.querySelector('main') || document.body;
          const text = (main.textContent || '');
          if (text.length < 200) return false;
          if (document.querySelector('h1')) return true;
          if (/Прикреплённ?ые\s+файл|Заказчик|Этапы\s+задания/i.test(text)) return true;
          return false;
        },
        { timeout: 12_000, polling: 400 },
      );
    } catch {
      log.warn('detail did not render in 12s — scraping anyway');
    }
    // Small settle delay for late-rendering description text
    await this.page.waitForTimeout(800);

    const data = await this.page.evaluate(extractTaskDetailInPage);
    const detail = { id: String(taskId), ...data };

    // Return to the feed so the main polling loop keeps reusing this page.
    try {
      await this.page.goto(config.freelancerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this._waitForFeed();
    } catch (e) {
      log.warn('return to feed failed:', e?.message || e);
    }

    return detail;
  }

  /**
   * Post the first-reply chat message on a task page (clicks "Согласиться").
   * Caller is responsible for ensuring this is the right action.
   *
   * Returns { ok, reason } — `ok=true` on success, otherwise `reason` is a
   * short tag explaining why we didn't / couldn't send.
   *
   * @param {string} taskId
   * @param {string} text
   */
  async postFirstReply(taskId, text) {
    if (!this.page) throw new Error('Scraper not started');
    if (!text || text.trim().length < 30) return { ok: false, reason: 'empty-or-short-text' };

    const detailUrl = `https://client.work-zilla.com/freelancer/${taskId}`;
    log.info(`[${taskId}] posting reply (${text.length} chars)`);
    try {
      await this.page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (e) {
      return { ok: false, reason: 'goto-failed: ' + (e?.message || e) };
    }
    await this._assertLoggedIn();

    // Wait for the reply UI: textarea + accept button must both be present
    try {
      await this.page.waitForFunction(() => {
        const ta = document.querySelector('textarea.resizable-textarea');
        const accept = [...document.querySelectorAll('a, button')].find((el) => /^Согласиться$/.test((el.textContent || '').trim()));
        return !!(ta && accept);
      }, { timeout: 12_000, polling: 400 });
    } catch {
      // Either chat already engaged (we already replied) or task is gone / queued
      const state = await this.page.evaluate(() => {
        const stub = document.querySelector('.stub-title')?.textContent || '';
        const queueText = (document.querySelector('main')?.textContent || '').slice(0, 400);
        return { stub, queueText };
      });
      log.warn(`[${taskId}] reply UI not present`, state.stub || '');
      try { await this.page.goto(config.freelancerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await this._waitForFeed(); } catch {}
      if (/уже откликнулись|уже\s+в\s+очереди|очередь\s+откликов/i.test(state.queueText)) {
        return { ok: false, reason: 'already-applied' };
      }
      if (/больше\s+не\s+доступно|задание.*снято/i.test(state.queueText)) {
        return { ok: false, reason: 'task-gone' };
      }
      return { ok: false, reason: 'no-reply-ui' };
    }

    // Type into the textarea (clear first just in case it has residue)
    try {
      await this.page.fill('textarea.resizable-textarea', '');
      await this.page.fill('textarea.resizable-textarea', text);
    } catch (e) {
      return { ok: false, reason: 'fill-failed: ' + (e?.message || e) };
    }

    // Click "Согласиться". Locator scoped to the link variant (rejects share .white modifier).
    try {
      const accept = this.page.locator('a.wz-button.order-button:not(.white)').filter({ hasText: 'Согласиться' }).first();
      await accept.click({ timeout: 8_000 });
    } catch (e) {
      return { ok: false, reason: 'click-failed: ' + (e?.message || e) };
    }

    // Verify: post-click, the "Согласиться" button must be gone OR a queue/accepted
    // status must appear. We do NOT trust main.textContent inclusion — the
    // textarea we just filled is part of main.textContent (false positive bug).
    let posted = false;
    let reason = 'verify-timeout';
    try {
      await this.page.waitForFunction(() => {
        if (location.pathname.startsWith('/account/login')) return false;
        const acceptBtn = [...document.querySelectorAll('a, button')].find((el) =>
          /^Согласиться$/.test((el.textContent || '').trim()),
        );
        if (!acceptBtn) return 'btn-gone';
        const main = (document.querySelector('main')?.textContent || '');
        if (/Вы\s+(?:в\s+очереди|откликнулись|согласились|подали)|Ваш\s+отклик|Заявка\s+отправлена|Ожидайте\s+ответ/i.test(main)) {
          return 'status-shown';
        }
        return false;
      }, { timeout: 15_000, polling: 500 });
      posted = true;
      reason = 'sent';
    } catch {
      // Diagnostic: snapshot DOM state on failure
      try {
        const snap = await this.page.evaluate(() => {
          const ta = document.querySelector('textarea.resizable-textarea');
          const accept = [...document.querySelectorAll('a, button')].find((el) =>
            /^Согласиться$/.test((el.textContent || '').trim()),
          );
          const reject = [...document.querySelectorAll('a, button')].find((el) =>
            /^Отказаться$/.test((el.textContent || '').trim()),
          );
          // Look for any modal/overlay that may have intercepted the click
          const modal = document.querySelector('[class*="modal"], [class*="Modal"], [class*="dialog"], [role="dialog"]');
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          return {
            url: location.href,
            taPresent: !!ta,
            taValue: ta ? (ta.value || '').slice(0, 80) : null,
            acceptPresent: !!accept,
            acceptDisabled: accept ? !!accept.disabled || accept.classList?.contains('disabled') : null,
            rejectPresent: !!reject,
            modal: modal ? norm(modal.textContent || '') : null,
            mainHead: norm((document.querySelector('main')?.textContent || '').slice(0, 400)),
          };
        });
        log.warn(`[${taskId}] post-verify TIMEOUT diagnostic: ${JSON.stringify(snap)}`);
        if (snap.url.includes('/account/login')) return { ok: false, reason: 'session-lost' };
        if (snap.modal) reason = 'blocked-by-modal';
        else if (snap.acceptPresent && snap.acceptDisabled) reason = 'btn-still-disabled';
        else if (snap.acceptPresent) reason = 'click-no-effect';
        try {
          const shot = await this.page.screenshot({ fullPage: false, type: 'png' });
          const shotPath = path.join(config.tmpDir, `${taskId}-post-fail.png`);
          fs.mkdirSync(path.dirname(shotPath), { recursive: true });
          fs.writeFileSync(shotPath, shot);
          log.warn(`[${taskId}] saved screenshot → ${shotPath}`);
        } catch {}
      } catch (e) {
        log.warn(`[${taskId}] diagnostic snapshot failed:`, e?.message || e);
      }
    }

    // Return to feed so monitoring loop continues
    try {
      await this.page.goto(config.freelancerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this._waitForFeed();
    } catch {}
    return { ok: posted, reason };
  }

  /**
   * Scrape /freelancer/current-orders for chat-preview state per active task.
   * Uses a SEPARATE Page in the same browser context so the main feed-loop
   * (this.page) is not disturbed and we don't need a mutex.
   *
   * @returns {Promise<Array<{
   *   id: string, title: string, price: string, partnerName: string,
   *   lastMsg: string, lastMsgTime: string,
   *   lastMsgKind: 'system'|'mine'|'partner',
   *   url: string,
   * }>>}
   */
  async scrapeInbox() {
    if (!this.context) throw new Error('Scraper not started');
    if (!this._inboxPage || this._inboxPage.isClosed()) {
      this._inboxPage = await this.context.newPage();
    }
    const p = this._inboxPage;
    const url = config.currentOrdersUrl || 'https://client.work-zilla.com/freelancer/current-orders';
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (e) {
      log.warn('inbox goto failed:', e?.message || e);
      return [];
    }
    if (p.url().includes('/account/login')) {
      throw new SessionExpiredError(p.url());
    }
    // Wait for at least one .order-container to render OR the empty-state message.
    try {
      await p.waitForFunction(() => {
        if (location.pathname.startsWith('/account/login')) return true;
        if (document.querySelector('a.order-container[data-order-id]')) return true;
        const main = document.querySelector('main');
        if (main && /нет\s+открытых|пока\s+пусто|нет\s+активн/i.test(main.textContent || '')) return true;
        return false;
      }, { timeout: 15_000, polling: 500 });
    } catch {
      log.warn('inbox feed did not render in 15s — extracting anyway');
    }
    return await p.evaluate(extractInboxInPage);
  }

  /**
   * Scrape full chat history of a task. Uses the SAME separate page as the
   * inbox loop (_inboxPage) so the main feed loop is never disturbed.
   * @param {string} taskId
   * @returns {Promise<Array<{side:'self'|'partner'|'system',text:string,time:string}>>}
   */
  /**
   * Scrape task detail + chat in one pass using _inboxPage (does not disturb main feed).
   * Used by the task-dump feature to create folders for accepted tasks.
   * @param {string} taskId
   * @returns {Promise<{detail: object, chat: Array}>}
   */
  async scrapeTaskForDump(taskId) {
    if (!this.context) throw new Error('Scraper not started');
    if (!this._inboxPage || this._inboxPage.isClosed()) {
      this._inboxPage = await this.context.newPage();
    }
    const p = this._inboxPage;
    await p.goto(`https://client.work-zilla.com/freelancer/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (p.url().includes('/account/login')) throw new SessionExpiredError(p.url());
    try {
      await p.waitForFunction(() => {
        const main = document.querySelector('main') || document.body;
        return (main?.textContent?.length || 0) > 200 && !!document.querySelector('h1');
      }, { timeout: 12_000, polling: 400 });
    } catch {
      log.warn(`[${taskId}] task detail page slow — scraping anyway`);
    }
    await p.waitForTimeout(800);
    const detail = await p.evaluate(extractTaskDetailInPage);
    detail.id = String(taskId);
    detail.url = `https://client.work-zilla.com/freelancer/${taskId}`;
    try {
      await p.waitForSelector('.chat-message-row, .no-messages', { timeout: 8_000 });
    } catch {}
    await p.waitForTimeout(400);
    const chat = await p.evaluate(extractChatInPage);
    return { detail, chat };
  }

  async scrapeChat(taskId) {
    if (!this.context) throw new Error('Scraper not started');
    if (!this._inboxPage || this._inboxPage.isClosed()) {
      this._inboxPage = await this.context.newPage();
    }
    const p = this._inboxPage;
    await p.goto(`https://client.work-zilla.com/freelancer/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (p.url().includes('/account/login')) throw new SessionExpiredError(p.url());
    try {
      await p.waitForSelector('.chat-message-row, .no-messages', { timeout: 12_000 });
    } catch {
      log.warn(`[${taskId}] chat did not render in 12s`);
    }
    await p.waitForTimeout(600);
    return await p.evaluate(extractChatInPage);
  }

  /**
   * Post a message into an ALREADY-OPEN task chat (followup engine).
   * Unlike postFirstReply there is no «Согласиться» button — just the chat
   * textarea + send control.
   * @param {string} taskId
   * @param {string} text
   * @returns {Promise<{ok:boolean, reason:string}>}
   */
  async postChatMessage(taskId, text) {
    if (!this.context) throw new Error('Scraper not started');
    if (!text || text.trim().length < 2) return { ok: false, reason: 'empty-text' };
    if (!this._inboxPage || this._inboxPage.isClosed()) {
      this._inboxPage = await this.context.newPage();
    }
    const p = this._inboxPage;
    try {
      await p.goto(`https://client.work-zilla.com/freelancer/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (e) {
      return { ok: false, reason: 'goto-failed: ' + (e?.message || e) };
    }
    if (p.url().includes('/account/login')) throw new SessionExpiredError(p.url());

    try {
      await p.waitForSelector('textarea.resizable-textarea', { timeout: 12_000 });
    } catch {
      return { ok: false, reason: 'no-chat-textarea' };
    }

    try {
      await p.fill('textarea.resizable-textarea', '');
      await p.fill('textarea.resizable-textarea', text);
    } catch (e) {
      return { ok: false, reason: 'fill-failed: ' + (e?.message || e) };
    }

    // Send: try the dedicated send control first, fall back to Enter.
    const sendCandidates = [
      '.send-message-button', '.send-button', '[class*="send-message"]',
      'button[type="submit"]', '[class*="SendButton"]', '.chat-send',
    ];
    let clicked = false;
    for (const sel of sendCandidates) {
      const el = p.locator(sel).first();
      try {
        if (await el.isVisible({ timeout: 500 })) {
          await el.click({ timeout: 3_000 });
          clicked = true;
          break;
        }
      } catch { /* try next */ }
    }
    if (!clicked) {
      try { await p.press('textarea.resizable-textarea', 'Enter'); } catch (e) {
        return { ok: false, reason: 'send-failed: ' + (e?.message || e) };
      }
    }

    // Verify: our message text should appear in the chat as a self row,
    // and the textarea should be empty again.
    const probe = text.trim().slice(0, 60);
    try {
      await p.waitForFunction((needle) => {
        const rows = document.querySelectorAll('.chat-message-row.self');
        for (const r of rows) {
          if ((r.textContent || '').includes(needle)) return true;
        }
        return false;
      }, probe, { timeout: 10_000, polling: 400 });
      return { ok: true, reason: 'sent' };
    } catch {
      const taVal = await p.evaluate(() => document.querySelector('textarea.resizable-textarea')?.value || '');
      if (!taVal.trim()) return { ok: true, reason: 'sent-probably (textarea cleared)' };
      return { ok: false, reason: 'verify-timeout' };
    }
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
    try { await this._inboxPage?.close(); } catch {}
    try { await this.context?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.page = this.context = this.browser = this._inboxPage = null;
  }
}
