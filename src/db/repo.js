'use strict';
// Data-access layer. Picks the driver from DB_DRIVER and adds small helpers
// (id counters, key/value) on top of the generic document API.
const { SqliteDriver } = require('./sqlite');
const { PostgresDriver } = require('./postgres');

class Repo {
  constructor(driver) {
    this.driver = driver;
    this.name = driver.name;
  }

  static async create({ driver = 'sqlite', sqlitePath, databaseUrl }) {
    const d = driver === 'postgres' ? new PostgresDriver(databaseUrl) : new SqliteDriver(sqlitePath);
    await d.init();
    return new Repo(d);
  }

  get(coll, id) { return this.driver.get(coll, id); }
  list(coll, opts) { return this.driver.list(coll, opts); }
  put(coll, id, data) { return this.driver.put(coll, id, data); }
  putMany(coll, items) { return this.driver.putMany(coll, items); }
  del(coll, id) { return this.driver.del(coll, id); }
  clear(coll) { return this.driver.clear(coll); }
  count(coll) { return this.driver.count(coll); }
  trim(coll, keep) { return this.driver.trim(coll, keep); }
  ping() { return this.driver.ping(); }
  close() { return this.driver.close(); }

  // Key/value helpers (stored in the "kv" collection).
  async kvGet(key, fallback = null) {
    const doc = await this.driver.get('kv', key);
    return doc ? doc.value : fallback;
  }

  async kvSet(key, value) {
    await this.driver.put('kv', key, { value });
    return value;
  }

  // Monotonic integer ids per collection.
  async nextId(coll) {
    const n = (await this.kvGet(`counter:${coll}`, 0)) + 1;
    await this.kvSet(`counter:${coll}`, n);
    return n;
  }

  async setCounter(coll, n) {
    await this.kvSet(`counter:${coll}`, n);
  }
}

module.exports = { Repo };
