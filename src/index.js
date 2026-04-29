import { config, log } from './config.js';
import { Scraper, SessionExpiredError } from './scrape.js';
import { SeenStore } from './store.js';
import { Telegram } from './telegram.js';

const SESSION_RETRY_MS = 5 * 60_000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const tg = new Telegram(config.telegram);
  const store = new SeenStore(config.seenStorePath);
  const scraper = new Scraper();

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log.info(`Shutdown (${sig})`);
    try { await scraper.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // First start with retries on startup failures
  while (!stopping) {
    try {
      await scraper.start();
      break;
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        log.error(e.message);
        await tg.sendAlert('🔐 Сессия истекла. Обнови storageState.json и перезапусти сервис.').catch(() => {});
        await sleep(SESSION_RETRY_MS);
        continue;
      }
      log.error('startup failed:', e?.message || e);
      await sleep(15_000);
    }
  }

  log.info('Monitor started. poll =', config.pollIntervalMs, 'ms');

  let coldStart = store.isEmpty();
  let cycle = 0;
  // Persist rotating cookies back to storageState.json every ~5 minutes
  // so a restart picks up the fresh Bearer / session cookies.
  const SAVE_SESSION_EVERY = Math.max(1, Math.floor((5 * 60_000) / config.pollIntervalMs));

  while (!stopping) {
    cycle++;
    try {
      if (cycle > 1) await scraper.refresh();
      const tasks = await scraper.scrapeTasks();
      const ids = tasks.map((t) => t.id);

      if (coldStart) {
        store.seedAll(ids);
        log.info(`cold start: marked ${ids.length} task(s) as seen, no notifications sent`);
        coldStart = false;
      } else {
        const newIds = new Set(store.filterNew(ids));
        if (newIds.size > 0) {
          log.info(`new tasks: ${newIds.size}`);
          for (const t of tasks) {
            if (!newIds.has(t.id)) continue;
            try {
              await tg.sendTask(t);
              store.markSeen(t.id);
            } catch (e) {
              log.error('failed to notify task', t.id, e?.message || e);
              // Don't mark seen — retry next cycle.
            }
          }
        } else {
          log.debug('no new tasks');
        }
      }

      if (cycle % SAVE_SESSION_EVERY === 0) {
        await scraper.saveSession();
        log.debug('session saved');
      }
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        log.error(e.message);
        await tg.sendAlert('🔐 Сессия истекла. Обнови storageState.json и перезапусти сервис.').catch(() => {});
        try { await scraper.close(); } catch {}
        await sleep(SESSION_RETRY_MS);
        // Re-init browser; will re-throw if still bad.
        try { await scraper.start(); } catch (e2) { log.error('reinit failed:', e2?.message || e2); }
        continue;
      }
      log.error('cycle error:', e?.message || e);
    }

    await sleep(config.pollIntervalMs);
  }
}

main().catch((e) => {
  log.error('fatal:', e?.stack || e);
  process.exit(1);
});
