'use strict';
// SQLite driver (better-sqlite3). Everything lives in one generic "docs" table:
// (coll, id) -> JSON document. Insertion order is kept by SQLite's rowid.
const fs = require('node:fs');
const path = require('node:path');

class SqliteDriver {
  constructor(file) {
    this.file = file;
    this.name = 'sqlite';
  }

  async init() {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    this.db = new Database(this.file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS docs (
      coll TEXT NOT NULL,
      id   TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (coll, id)
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS docs_coll ON docs (coll)');
    this.stmt = {
      get: this.db.prepare('SELECT data FROM docs WHERE coll = ? AND id = ?'),
      listAsc: this.db.prepare('SELECT id, data FROM docs WHERE coll = ? ORDER BY rowid ASC'),
      listDesc: this.db.prepare('SELECT id, data FROM docs WHERE coll = ? ORDER BY rowid DESC LIMIT ?'),
      put: this.db.prepare(`INSERT INTO docs (coll, id, data) VALUES (?, ?, ?)
        ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data`),
      del: this.db.prepare('DELETE FROM docs WHERE coll = ? AND id = ?'),
      clear: this.db.prepare('DELETE FROM docs WHERE coll = ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE coll = ?'),
      trim: this.db.prepare(`DELETE FROM docs WHERE coll = ? AND rowid NOT IN
        (SELECT rowid FROM docs WHERE coll = ? ORDER BY rowid DESC LIMIT ?)`),
    };
  }

  async get(coll, id) {
    const row = this.stmt.get.get(coll, String(id));
    return row ? JSON.parse(row.data) : null;
  }

  async list(coll, { order = 'asc', limit } = {}) {
    const rows = order === 'desc'
      ? this.stmt.listDesc.all(coll, limit || -1)
      : this.stmt.listAsc.all(coll);
    const out = rows.map((r) => JSON.parse(r.data));
    return order === 'asc' && limit ? out.slice(0, limit) : out;
  }

  async put(coll, id, data) {
    this.stmt.put.run(coll, String(id), JSON.stringify(data));
    return data;
  }

  async putMany(coll, items) {
    const tx = this.db.transaction((list) => {
      for (const { id, data } of list) this.stmt.put.run(coll, String(id), JSON.stringify(data));
    });
    tx(items);
  }

  async del(coll, id) {
    return this.stmt.del.run(coll, String(id)).changes > 0;
  }

  async clear(coll) {
    this.stmt.clear.run(coll);
  }

  async count(coll) {
    return this.stmt.count.get(coll).n;
  }

  async trim(coll, keep) {
    this.stmt.trim.run(coll, coll, keep);
  }

  async ping() {
    this.db.prepare('SELECT 1').get();
    return true;
  }

  async close() {
    if (this.db) this.db.close();
  }
}

module.exports = { SqliteDriver };
