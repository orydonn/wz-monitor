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
