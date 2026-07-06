import { config, log } from './config.js';
import { Scraper, SessionExpiredError } from './scrape.js';
import { SeenStore, JsonMap } from './store.js';
import { Telegram } from './telegram.js';
import { runPipeline } from './pipeline.js';
import { cleanupOldTmp } from './files.js';
import { draftFollowup } from './ai.js';
import { dumpAcceptedTask } from './task-dump.js';

const SESSION_RETRY_MS = 5 * 60_000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Sliding-window rate limiter for auto-post (last 1h).
function makeRateLimiter(maxPerHour) {
  const stamps = [];
  const WINDOW = 60 * 60_000;
  return {
    allow() {
      const now = Date.now();
      while (stamps.length && now - stamps[0] > WINDOW) stamps.shift();
      return stamps.length < maxPerHour;
    },
    record() {
      stamps.push(Date.now());
    },
    used() { return stamps.length; },
  };
}
const postRateLimiter = makeRateLimiter(0);

async function main() {
  const tg = new Telegram(config.telegram);
  const tgInbox = config.telegramInboxBotToken
    ? new Telegram({ botToken: config.telegramInboxBotToken, chatId: config.telegram.chatId })
    : null;
  const store = new SeenStore(config.seenStorePath);
  const inboxStore = new SeenStore(config.inboxStorePath);
  const followups = new JsonMap(config.followupStorePath);
  const taskDumpStore = config.taskDumpEnabled ? new SeenStore(config.taskDumpStorePath) : null;
  const scraper = new Scraper();

  const fuJitter = () => config.followupDelayMs + Math.floor(Math.random() * config.followupJitterMs);
  const aiOpts = () => ({
    claudeBin: config.claudeBin,
    claudeModel: config.claudeModel,
    effort: config.claudeEffort,
    timeoutMs: config.claudeTimeoutMs,
  });

  // One followup job: scrape full chat → guards → codex decision → act.
  async function runFollowupJob(it, st) {
    st.dueAt = null;
    if (st.sent >= config.followupMaxPerTask) {
      st.stage = 'capped';
      followups.set(it.id, st);
      log.info(`[${it.id}] followup: cap reached (${st.sent})`);
      return;
    }

    let chat;
    try {
      chat = await scraper.scrapeChat(it.id);
    } catch (e) {
      if (e instanceof SessionExpiredError) throw e;
      log.warn(`[${it.id}] followup: chat scrape failed:`, e?.message || e);
      st.dueAt = Date.now() + config.inboxPollIntervalMs * 2; // retry soon
      followups.set(it.id, st);
      return;
    }

    // Guard: we were chosen as the executor → selling phase is over.
    if (chat.some((m) => m.side === 'system' && /назначены исполнителем/i.test(m.text))) {
      st.stage = 'won';
      followups.set(it.id, st);
      log.info(`[${it.id}] followup: WON (назначен исполнителем)`);
      await (tgInbox || tg).sendAlert(`🏁 Выбрали исполнителем: ${it.title || it.id}\n${it.url}`).catch(() => {});
      return;
    }

    // Guard: manual takeover — a self message we did not send.
    const ours = st.ourMsgs || [];
    const foreignSelf = chat.some((m) =>
      m.side === 'self' &&
      !ours.some((o) => m.text.includes(o.slice(0, 40)) || o.includes(m.text.slice(0, 40))),
    );
    if (foreignSelf) {
      st.stage = 'manual';
      followups.set(it.id, st);
      log.info(`[${it.id}] followup: manual takeover detected, disengaging`);
      return;
    }

    const mode = st.pending === 'reply' ? 'reply' : 'bump';
    const res = await draftFollowup(
      { task: st.task || { title: it.title, price: it.price }, files: [], chat, mode, sent: st.sent, max: config.followupMaxPerTask },
      aiOpts(),
    );
    log.info(`[${it.id}] followup ${mode}: action=${res.action} (ai ${res.duration_ms}ms)`);

    const lastPartner = [...chat].reverse().find((m) => m.side === 'partner')?.text || '';

    if (res.action === 'reply' || res.action === 'decline') {
      if (res.action === 'decline' && !config.followupAutoDecline) {
        await tg.sendFollowupEscalation(it, `Хочу отказаться (авто-отказ выключен): ${res.reason}\n\nЧерновик отказа:\n${res.message}`, lastPartner).catch(() => {});
        st.pending = null;
        st.stage = 'engaged';
        followups.set(it.id, st);
        return;
      }
      const r = await scraper.postChatMessage(it.id, res.message);
      if (r.ok) {
        st.sent += 1;
        st.ourMsgs = [...ours, res.message];
        st.pending = null;
        st.stage = res.action === 'decline' ? 'declined' : 'engaged';
        followups.set(it.id, st);
        await tg.sendFollowupMirror(it, res).catch(() => {});
      } else {
        log.warn(`[${it.id}] followup post failed: ${r.reason}`);
        await tg.sendAlert(`followup не отправился [${it.id}]: ${r.reason}`).catch(() => {});
        st.pending = null;
        followups.set(it.id, st);
      }
      return;
    }

    if (res.action === 'escalate') {
      await (tgInbox || tg).sendFollowupEscalation(it, res.reason, lastPartner).catch(() => {});
      st.pending = null;
      st.stage = 'engaged';
      followups.set(it.id, st);
      return;
    }

    // silent
    st.pending = null;
    st.stage = 'engaged';
    followups.set(it.id, st);
  }

  // Followup state machine — driven by the inbox tick (every 30s).
  async function followupTick(items) {
    for (const it of items) {
      const st = followups.get(it.id);
      if (!st) continue;
      if (['won', 'manual', 'capped', 'declined', 'done'].includes(st.stage)) continue;

      try {
        // Unlock: queue placeholder → real chat preview.
        if (st.stage === 'queued' && it.chatOpen) {
          st.stage = 'unlocked';
          st.pending = 'bump';
          st.dueAt = Date.now() + fuJitter();
          followups.set(it.id, st);
          log.info(`[${it.id}] followup: chat unlocked, job in ~${Math.round((st.dueAt - Date.now()) / 1000)}s`);
        }

        // New partner message → (re)arm the reply timer. Re-arming on every
        // new message batches a burst of messages into a single reply.
        if (it.chatOpen && it.lastMsgKind === 'partner') {
          const sig = `${it.lastMsg}|${it.lastMsgTime}`;
          if (sig !== st.lastPartnerSig) {
            st.lastPartnerSig = sig;
            st.pending = 'reply';
            st.dueAt = Date.now() + fuJitter();
            if (st.stage === 'queued') st.stage = 'unlocked';
            followups.set(it.id, st);
            log.info(`[${it.id}] followup: partner message, reply in ~${Math.round((st.dueAt - Date.now()) / 1000)}s`);
          }
        }

        if (st.pending && st.dueAt && Date.now() >= st.dueAt) {
          await runFollowupJob(it, st);
        }
      } catch (e) {
        if (e instanceof SessionExpiredError) throw e;
        log.warn(`[${it.id}] followup tick error:`, e?.message || e);
      }
    }
  }

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
      try { await scraper.close(); } catch {}
      await sleep(15_000);
    }
  }

  // Configure rate limiter now that config is loaded.
  postRateLimiter.maxPerHour = config.maxPostsPerHour;
  Object.assign(postRateLimiter, makeRateLimiter(config.maxPostsPerHour));
  log.info('Monitor started. poll =', config.pollIntervalMs, 'ms · auto-post =', config.autoPostEnabled, '· max/hr =', config.maxPostsPerHour);
  log.info('Inbox-loop:', tgInbox ? `enabled, poll=${config.inboxPollIntervalMs}ms` : 'disabled (no TELEGRAM_INBOX_BOT_TOKEN)');
  log.info('Followup-engine:', config.followupEnabled
    ? `enabled, delay=${Math.round(config.followupDelayMs / 1000)}s+jitter, max=${config.followupMaxPerTask}/task, auto-decline=${config.followupAutoDecline}`
    : 'disabled');

  // Independent inbox poller — runs alongside the feed loop. Uses a separate
  // Page in the same browser context, so it never blocks the main loop.
  let inboxColdStart = inboxStore.isEmpty();
  if (tgInbox || config.followupEnabled || config.taskDumpEnabled) {
    const inboxTick = async () => {
      if (stopping) return;
      try {
        const items = await scraper.scrapeInbox();
        const ids = items.map((i) => i.id);
        if (inboxColdStart) {
          // First run after install — seed all current tasks so we don't alert
          // for stale partner messages that pre-date the deploy.
          inboxStore.seedAll(ids);
          log.info(`inbox cold start: seeded ${ids.length} task(s)`);
          inboxColdStart = false;
          return;
        }

        if (tgInbox) {
          const fresh = items.filter((i) => i.lastMsgKind === 'partner' && !inboxStore.ids.has(i.id));
          if (fresh.length > 0) {
            log.info(`inbox: ${fresh.length} new partner message(s)`);
            for (const t of fresh) {
              try {
                await tgInbox.sendInboxAlert(t);
                inboxStore.markSeen(t.id);
              } catch (e) {
                log.error(`inbox alert failed for ${t.id}:`, e?.message || e);
              }
            }
          } else {
            log.debug('inbox: no new partner messages');
          }
        }

        if (config.taskDumpEnabled && taskDumpStore) {
          const notDumped = items.filter(i => !taskDumpStore.ids.has(i.id));
          for (const t of notDumped) {
            try {
              await dumpAcceptedTask(scraper, t.id, t, config.taskDumpDir);
              taskDumpStore.markSeen(t.id);
            } catch (e) {
              log.warn(`[dump ${t.id}] failed:`, e?.message || e);
            }
          }
        }

        if (config.followupEnabled) await followupTick(items);
      } catch (e) {
        if (e instanceof SessionExpiredError) {
          log.warn('inbox poll: session expired');
          return; // feed-loop session-handler will recover
        }
        log.warn('inbox poll error:', e?.message || e);
      } finally {
        if (!stopping) setTimeout(inboxTick, config.inboxPollIntervalMs);
      }
    };
    setTimeout(inboxTick, 5_000); // small delay so feed-loop opens its page first
  }

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
              if (config.draftEnabled) {
                const result = await runPipeline(scraper, t);
                let postVerdict = result.verdict;
                let postReason;
                // If Codex says draft AND AUTO_POST is on AND we haven't blown
                // the per-hour quota — actually post it.
                if (
                  result.verdict === 'draft' &&
                  config.autoPostEnabled &&
                  result.draft_reply &&
                  postRateLimiter.allow()
                ) {
                  const r = await scraper.postFirstReply(t.id, result.draft_reply);
                  postVerdict = r.ok ? 'posted' : 'post-failed';
                  postReason = r.reason;
                  if (r.ok) {
                    postRateLimiter.record();
                    // Register the task with the followup engine: when the
                    // chat unlocks («Обмен контактами…»), it takes over.
                    if (config.followupEnabled) {
                      followups.set(t.id, {
                        stage: 'queued',
                        postedAt: Date.now(),
                        sent: 0,
                        ourMsgs: [result.draft_reply],
                        task: {
                          title: result.detail?.title || t.title,
                          description: (result.detail?.description || t.description || '').slice(0, 2000),
                          price: t.price,
                          deadline: t.deadline,
                        },
                      });
                    }
                  }
                  log.info(`[${t.id}] post=${postVerdict} reason=${r.reason || '-'}`);
                } else if (result.verdict === 'draft' && config.autoPostEnabled && !postRateLimiter.allow()) {
                  postVerdict = 'post-failed';
                  postReason = `rate-limit (>${config.maxPostsPerHour}/hr)`;
                  log.warn(`[${t.id}] rate-limited`);
                }
                await tg.sendTaskWithDraft(t, {
                  verdict: postVerdict,
                  draft_reply: result.draft_reply,
                  category: result.category,
                  theme: result.theme,
                  needs_clarification: result.needs_clarification,
                  refuse_reason: result.refuse_reason,
                  post_reason: postReason,
                });
              } else {
                await tg.sendTask(t);
              }
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
      // Cleanup tmp dirs once an hour
      if (cycle % Math.max(1, Math.floor((60 * 60_000) / config.pollIntervalMs)) === 0) {
        try { cleanupOldTmp(config.tmpDir); } catch {}
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
