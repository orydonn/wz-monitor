import { log } from './config.js';

const API = 'https://api.telegram.org';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(s, max = 300) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

function formatTask(task) {
  const lines = [];
  lines.push(`<b>${escapeHtml(task.title || 'Без названия')}</b>`);

  const meta = [];
  if (task.price) meta.push(`💰 ${escapeHtml(task.price)}`);
  if (task.deadline) meta.push(`⏱ ${escapeHtml(task.deadline)}`);
  if (meta.length) lines.push(meta.join('   '));

  if (task.description) lines.push('', escapeHtml(truncate(task.description, 300)));
  return lines.join('\n');
}

export class Telegram {
  constructor({ botToken, chatId }) {
    this.botToken = botToken;
    this.chatId = chatId;
    this._queue = Promise.resolve();
  }

  _enqueue(fn) {
    const next = this._queue.then(fn).catch((e) => log.error('telegram queue:', e?.message || e));
    // Pace ~1 msg/sec to respect TG limits
    this._queue = next.then(() => new Promise((r) => setTimeout(r, 1100)));
    return next;
  }

  async _post(method, payload) {
    const url = `${API}/bot${this.botToken}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok || data.ok === false) {
      const why = data?.description || `HTTP ${res.status}`;
      throw new Error(`Telegram ${method} failed: ${why}`);
    }
    return data;
  }

  sendTask(task) {
    return this._enqueue(() => this._post('sendMessage', {
      chat_id: this.chatId,
      text: formatTask(task),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: '🔗 Открыть на Workzilla', url: task.url }]],
      },
    }));
  }

  sendAlert(text) {
    return this._enqueue(() => this._post('sendMessage', {
      chat_id: this.chatId,
      text: `⚠️ <b>WZ-monitor</b>\n${escapeHtml(text)}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  }
}
