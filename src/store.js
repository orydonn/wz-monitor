import fs from 'node:fs';
import path from 'node:path';

export class SeenStore {
  constructor(filePath) {
    this.path = filePath;
    this.tmp = filePath + '.tmp';
    this.ids = new Set();
    this.firstSeenAt = {};
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.ids)) for (const id of data.ids) this.ids.add(String(id));
      if (data.firstSeenAt && typeof data.firstSeenAt === 'object') {
        this.firstSeenAt = data.firstSeenAt;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // First run — store will be created on first save
    }
  }

  isEmpty() {
    return this.ids.size === 0;
  }

  filterNew(ids) {
    return ids.filter((id) => !this.ids.has(String(id)));
  }

  markSeen(id) {
    const sid = String(id);
    if (this.ids.has(sid)) return false;
    this.ids.add(sid);
    this.firstSeenAt[sid] = Date.now();
    this._save();
    return true;
  }

  seedAll(ids) {
    const now = Date.now();
    for (const id of ids) {
      const sid = String(id);
      if (!this.ids.has(sid)) {
        this.ids.add(sid);
        this.firstSeenAt[sid] = now;
      }
    }
    this._save();
  }

  _save() {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(
      { ids: [...this.ids], firstSeenAt: this.firstSeenAt },
      null,
      0,
    );
    fs.writeFileSync(this.tmp, payload);
    fs.renameSync(this.tmp, this.path);
  }
}
