'use strict';
// Local-directory file store (use a mounted volume in containers).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { meter } = require('./meter');

class LocalFileStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.name = 'local';
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.mkdir(path.join(this.dir, '.tmp'), { recursive: true });
  }

  file(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(id) || /^\.+$/.test(id)) throw new Error('invalid file id');
    return path.join(this.dir, id);
  }

  async writeStream(id, readable, { maxBytes } = {}) {
    const tmp = path.join(this.dir, '.tmp', `${id}.${crypto.randomUUID()}`);
    const m = meter(maxBytes);
    try {
      await pipeline(readable, m.stream, fs.createWriteStream(tmp));
      await fsp.rename(tmp, this.file(id));
      return m.result();
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  async writeBuffer(id, buf) {
    await fsp.writeFile(this.file(id), buf);
    return { size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  }

  async read(id, { start, end } = {}) {
    return fs.createReadStream(this.file(id), start !== undefined ? { start, end } : undefined);
  }

  async readBuffer(id) {
    return fsp.readFile(this.file(id));
  }

  async stat(id) {
    try {
      const s = await fsp.stat(this.file(id));
      return { size: s.size, mtime: s.mtime };
    } catch {
      return null;
    }
  }

  async delete(id) {
    await fsp.rm(this.file(id), { force: true });
  }

  async ping() {
    await fsp.access(this.dir, fs.constants.W_OK);
    return true;
  }
}

module.exports = { LocalFileStore };
