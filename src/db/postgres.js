'use strict';
// Postgres driver (pg). Works with Neon or any Postgres via DATABASE_URL.
// Same generic "docs" table as the SQLite driver; insertion order kept by a BIGSERIAL.

class PostgresDriver {
  constructor(url) {
    this.url = url;
    this.name = 'postgres';
  }

  async init() {
    if (!this.url) throw new Error('DB_DRIVER=postgres requires DATABASE_URL');
    const { Pool } = require('pg');
    const needsSsl = /sslmode=require|neon\.tech/.test(this.url) && !/sslmode=disable/.test(this.url);
    this.pool = new Pool({
      connectionString: this.url,
      max: 10,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS docs (
      seq  BIGSERIAL,
      coll TEXT NOT NULL,
      id   TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (coll, id)
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS docs_coll_seq ON docs (coll, seq)');
  }

  async get(coll, id) {
    const r = await this.pool.query('SELECT data FROM docs WHERE coll = $1 AND id = $2', [coll, String(id)]);
    return r.rows[0] ? JSON.parse(r.rows[0].data) : null;
  }

  async list(coll, { order = 'asc', limit } = {}) {
    const dir = order === 'desc' ? 'DESC' : 'ASC';
    const sql = `SELECT data FROM docs WHERE coll = $1 ORDER BY seq ${dir}` + (limit ? ' LIMIT $2' : '');
    const r = await this.pool.query(sql, limit ? [coll, limit] : [coll]);
    return r.rows.map((row) => JSON.parse(row.data));
  }

  async put(coll, id, data) {
    await this.pool.query(
      `INSERT INTO docs (coll, id, data) VALUES ($1, $2, $3)
       ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data`,
      [coll, String(id), JSON.stringify(data)],
    );
    return data;
  }

  async putMany(coll, items) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Batch in chunks to keep parameter counts reasonable.
      for (let i = 0; i < items.length; i += 200) {
        const chunk = items.slice(i, i + 200);
        const values = [];
        const params = [];
        chunk.forEach((it, j) => {
          values.push(`($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`);
          params.push(coll, String(it.id), JSON.stringify(it.data));
        });
        await client.query(
          `INSERT INTO docs (coll, id, data) VALUES ${values.join(',')}
           ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data`,
          params,
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async del(coll, id) {
    const r = await this.pool.query('DELETE FROM docs WHERE coll = $1 AND id = $2', [coll, String(id)]);
    return r.rowCount > 0;
  }

  async clear(coll) {
    await this.pool.query('DELETE FROM docs WHERE coll = $1', [coll]);
  }

  async count(coll) {
    const r = await this.pool.query('SELECT COUNT(*)::int AS n FROM docs WHERE coll = $1', [coll]);
    return r.rows[0].n;
  }

  async trim(coll, keep) {
    await this.pool.query(
      `DELETE FROM docs WHERE coll = $1 AND seq NOT IN
       (SELECT seq FROM docs WHERE coll = $1 ORDER BY seq DESC LIMIT $2)`,
      [coll, keep],
    );
  }

  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

module.exports = { PostgresDriver };
