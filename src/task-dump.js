import fs from 'node:fs';
import path from 'node:path';
import { log } from './config.js';

const TRANSLIT = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'yo', ж:'zh', з:'z',
  и:'i', й:'y', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r',
  с:'s', т:'t', у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh',
  щ:'sch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
};

function translit(text) {
  let out = '';
  for (const ch of String(text || '')) {
    const lower = ch.toLowerCase();
    out += lower in TRANSLIT ? TRANSLIT[lower] : ch;
  }
  return out;
}

function slugifyTitle(title) {
  let s = String(title || '').toLowerCase();
  s = translit(s);
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 60) s = s.slice(0, 60).replace(/-+$/, '');
  return s || 'task';
}

export function folderName(title, id) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${slugifyTitle(title)}-${id}-${yyyy}-${mm}-${dd}`;
}

function nowStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeMd(s) {
  return String(s || '').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function sanitizeFilename(name, fallback) {
  const s = String(name || fallback || 'file')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .trim();
  return s || fallback || 'file';
}

function renderTaskMd(detail, chat, fileResults) {
  const fileMap = new Map();
  for (const r of fileResults || []) {
    if (r.sourceUrl) fileMap.set(r.sourceUrl, r);
  }

  const lines = [];
  lines.push(`# ${detail.title || 'Задание Workzilla'}`);
  lines.push('');
  lines.push(`- **ID**: ${detail.id}`);
  lines.push(`- **URL**: ${detail.url}`);
  if (detail.price) lines.push(`- **Цена**: ${detail.price}`);
  if (detail.deadline) lines.push(`- **Срок**: ${detail.deadline}`);
  if (detail.client) lines.push(`- **Заказчик**: ${detail.client}`);
  lines.push(`- **Статус**: В работе`);
  lines.push(`- **Сохранено**: ${nowStr()}`);
  lines.push('');
  lines.push('## Описание');
  lines.push('');
  lines.push((detail.description || '*(пусто)*').trim());
  lines.push('');

  const taskFiles = detail.files || [];
  if (taskFiles.length) {
    lines.push('### Прикреплённые файлы (к заданию)');
    lines.push('');
    for (const f of taskFiles) {
      const r = fileMap.get(f.url);
      if (r && r.localPath && !r.skipped) {
        const size = formatBytes(r.sizeBytes);
        const base = path.basename(r.localPath);
        lines.push(`- [${escapeMd(f.name)}](./files/${encodeURIComponent(base)})${size ? `  *(${size})*` : ''}`);
      } else if (r?.skipped) {
        lines.push(`- ${escapeMd(f.name)} *(не скачан: ${r.skipped})*`);
      } else {
        lines.push(`- ${escapeMd(f.name)}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## Переписка');
  lines.push('');

  const chatMsgs = (chat || []).filter(m => m.text?.trim());
  if (!chatMsgs.length) {
    lines.push('*(переписка пуста)*');
    lines.push('');
  } else {
    for (const m of chatMsgs) {
      const sender =
        m.side === 'self' ? 'Я' :
        m.side === 'system' ? 'Система' :
        (detail.client ? `Заказчик · ${detail.client}` : 'Заказчик');
      lines.push(`### ${sender}${m.time ? ' · ' + m.time : ''}`);
      lines.push('');
      lines.push(m.text.trim());
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function downloadFiles(page, files, destDir) {
  const results = [];
  let idx = 0;
  for (const f of files) {
    const safeName = sanitizeFilename(f.name, `attachment-${++idx}`);
    const localPath = path.join(destDir, safeName);
    try {
      const res = await page.context().request.get(f.url, { timeout: 60_000 });
      if (!res.ok()) {
        results.push({ sourceUrl: f.url, localPath: null, sizeBytes: 0, skipped: `http-${res.status()}` });
        continue;
      }
      const buf = await res.body();
      if (buf.length > 50 * 1024 * 1024) {
        results.push({ sourceUrl: f.url, localPath: null, sizeBytes: buf.length, skipped: 'too-large' });
        continue;
      }
      fs.writeFileSync(localPath, buf);
      results.push({ sourceUrl: f.url, localPath, sizeBytes: buf.length, skipped: null });
    } catch (e) {
      log.warn(`[dump] download failed ${f.url}:`, e?.message);
      results.push({ sourceUrl: f.url, localPath: null, sizeBytes: 0, skipped: 'error' });
    }
  }
  return results;
}

/**
 * Create a task folder on E: drive with task.md + downloaded attachments.
 * Mirrors what `wz-download` / `wzd` does on Mac.
 *
 * @param {import('./scrape.js').Scraper} scraper
 * @param {string} taskId
 * @param {{title:string, price?:string, partnerName?:string, url?:string}} taskInfo - from scrapeInbox
 * @param {string} outDir - base output dir, e.g. /mnt/e/wz-tasks
 * @returns {Promise<string>} created folder path
 */
export async function dumpAcceptedTask(scraper, taskId, taskInfo, outDir) {
  log.info(`[dump ${taskId}] starting "${taskInfo.title || taskId}"`);

  let detail, chat;
  try {
    ({ detail, chat } = await scraper.scrapeTaskForDump(taskId));
    // Fill in fields not available on the detail page
    if (!detail.price && taskInfo.price) detail.price = taskInfo.price;
    if (!detail.client && taskInfo.partnerName) detail.client = taskInfo.partnerName;
  } catch (e) {
    log.warn(`[dump ${taskId}] scrape failed, using minimal info:`, e?.message);
    detail = {
      id: taskId,
      title: taskInfo.title || `task-${taskId}`,
      description: '',
      files: [],
      client: taskInfo.partnerName || '',
      price: taskInfo.price || '',
      url: `https://client.work-zilla.com/freelancer/${taskId}`,
    };
    chat = [];
  }

  const folder = folderName(detail.title || taskInfo.title || `task-${taskId}`, taskId);
  const taskDir = path.join(outDir, folder);
  const filesDir = path.join(taskDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  let fileResults = [];
  const allFiles = detail.files || [];
  if (allFiles.length) {
    const page = scraper._inboxPage || scraper.page;
    try {
      fileResults = await downloadFiles(page, allFiles, filesDir);
      const ok = fileResults.filter(r => !r.skipped).length;
      log.info(`[dump ${taskId}] files: ${ok}/${allFiles.length} downloaded`);
    } catch (e) {
      log.warn(`[dump ${taskId}] file download error:`, e?.message);
    }
  }

  const md = renderTaskMd(detail, chat, fileResults);
  fs.writeFileSync(path.join(taskDir, 'task.md'), md, 'utf8');
  log.info(`[dump ${taskId}] → ${taskDir}`);
  return taskDir;
}
