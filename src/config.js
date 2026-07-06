import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env: ${name}`);
  return v.trim();
}

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got: ${v}`);
  return n;
}

const root = process.cwd();
const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    chatId: required('TELEGRAM_CHAT_ID'),
  },
  pollIntervalMs: num('POLL_INTERVAL_MS', 30_000),
  storageStatePath: resolve(process.env.STORAGE_STATE_PATH || './storageState.json'),
  seenStorePath: resolve(process.env.SEEN_STORE_PATH || './seen.json'),
  freelancerUrl: process.env.WZ_FREELANCER_URL || 'https://client.work-zilla.com/freelancer',
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // Inbox alerts (second TG bot)
  telegramInboxBotToken: process.env.TELEGRAM_INBOX_BOT_TOKEN || '',
  inboxPollIntervalMs: num('INBOX_POLL_INTERVAL_MS', 30_000),
  inboxStorePath: resolve(process.env.INBOX_STORE_PATH || './inbox-seen.json'),
  currentOrdersUrl: process.env.CURRENT_ORDERS_URL || 'https://client.work-zilla.com/freelancer/current-orders',

  // Followup engine — continue the chat after the first offer
  followupEnabled: bool('FOLLOWUP_ENABLED', true),
  // Base delay before reacting (followup #1 after unlock; reply after a
  // partner message). Jitter is added on top so timing looks human.
  followupDelayMs: num('FOLLOWUP_DELAY_MS', 4 * 60_000),
  followupJitterMs: num('FOLLOWUP_JITTER_MS', 3 * 60_000),
  // Hard cap of auto-messages per task (followup #1 included).
  followupMaxPerTask: num('FOLLOWUP_MAX_PER_TASK', 3),
  followupStorePath: resolve(process.env.FOLLOWUP_STORE_PATH || './followup-state.json'),
  // When codex decides to decline (customer made the task infeasible):
  // true → post the decline into the chat automatically; false → only alert.
  followupAutoDecline: bool('FOLLOWUP_AUTO_DECLINE', true),

  // Auto-draft pipeline
  draftEnabled: bool('DRAFT_ENABLED', true),
  // Auto-post: if true, draft replies are posted to Workzilla chat
  // automatically. If false, draft is only sent to TG for review.
  autoPostEnabled: bool('AUTO_POST', false),
  // Hard rate limit — at most this many posts in a sliding 1-hour window.
  // Protects against any classifier regression that would otherwise spam
  // dozens of replies before user notices.
  maxPostsPerHour: num('MAX_POSTS_PER_HOUR', 12),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
  claudeEffort: process.env.CLAUDE_EFFORT || 'high',
  claudeTimeoutMs: num('CLAUDE_TIMEOUT_MS', 90_000),
  // Task dump — create wzd-style folders on acceptance
  taskDumpEnabled: !!process.env.WZ_TASKS_DIR,
  taskDumpDir: process.env.WZ_TASKS_DIR || '',
  taskDumpStorePath: resolve(process.env.WZ_TASKS_DUMP_PATH || './tasks-dumped.json'),

  tmpDir: resolve(process.env.TMP_DIR || './tmp/wz'),
  maxFileBytes: num('MAX_FILE_BYTES', 5 * 1024 * 1024),
  maxTotalBytes: num('MAX_TOTAL_BYTES', 20 * 1024 * 1024),
  maxFilesPerTask: num('MAX_FILES_PER_TASK', 10),
};

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const lvl = levels[config.logLevel] ?? 2;
function ts() {
  return new Date().toISOString();
}
export const log = {
  error: (...a) => lvl >= 0 && console.error(ts(), '[error]', ...a),
  warn:  (...a) => lvl >= 1 && console.warn(ts(),  '[warn] ', ...a),
  info:  (...a) => lvl >= 2 && console.log(ts(),   '[info] ', ...a),
  debug: (...a) => lvl >= 3 && console.log(ts(),   '[debug]', ...a),
};
