'use strict';
// Shared file pool: metadata in the DB ("files" collection), bytes in the configured store.
const crypto = require('node:crypto');
const path = require('node:path');
const { Readable } = require('node:stream');
const { LocalFileStore } = require('./fileStore/local');
const { S3FileStore } = require('./fileStore/s3');
const { HttpError } = require('../util/problem');

const TYPES = {
  '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain', '.pdf': 'application/pdf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.zip': 'application/zip', '.xml': 'application/xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.html': 'text/html', '.bin': 'application/octet-stream',
  '.yaml': 'application/yaml', '.yml': 'application/yaml', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4',
};

function guessType(name, fallback = 'application/octet-stream') {
  return TYPES[path.extname(name || '').toLowerCase()] || fallback;
}

function safeName(name) {
  const base = path.basename(String(name || 'upload.bin')).replace(/[\u0000-\u001f"\\]/g, '').trim();
  return base.slice(0, 200) || 'upload.bin';
}

async function createStore(settings) {
  const store = settings.get('fileStore') === 's3'
    ? new S3FileStore({
      bucket: settings.get('s3Bucket'), region: settings.get('s3Region'), endpoint: settings.get('s3Endpoint'),
      accessKeyId: settings.get('s3AccessKeyId'), secretAccessKey: settings.get('s3SecretAccessKey'),
      forcePathStyle: settings.get('s3ForcePathStyle'), prefix: settings.get('s3Prefix'),
    })
    : new LocalFileStore(settings.get('fileDir'));
  await store.init();
  return store;
}

class FileService {
  constructor(repo, store, settings) {
    this.repo = repo;
    this.store = store;
    this.settings = settings;
  }

  maxBytes() { return this.settings.get('maxFileSizeMb') * 1024 * 1024; }

  newId() { return `f_${crypto.randomBytes(9).toString('base64url')}`; }

  // File events for outgoing webhooks: 'file' { type: uploaded|downloaded|deleted, resource: 'files', id, at,
  // via, file, ...extra }. Emitted by the routes once an operation has really completed (not for
  // rolled-back uploads or regenerated samples). this.events is set by the app (ctx.events).
  emit(type, doc, via, extra = {}) {
    if (!this.events || !doc) return;
    try {
      this.events.emit('file', {
        type, resource: 'files', id: doc.id, at: new Date().toISOString(), via,
        file: { id: doc.id, name: doc.name, contentType: doc.contentType, size: doc.size, sha256: doc.sha256 || null, source: doc.source, createdAt: doc.createdAt, updatedAt: doc.updatedAt },
        ...extra,
      });
    } catch { /* a listener must never break a file operation */ }
  }

  // Emit 'downloaded' when a GET that sends the file's bytes completes (200 or 206). A client may read the
  // whole body and hang up before the response's 'finish' event, so success is also judged on 'close':
  // every byte of a Content-Length body was written, or the response was ended.
  trackDownload(req, res, doc, via) {
    if (req.method !== 'GET') return;
    let written = 0;
    const count = (chunk, enc) => { if (chunk && typeof chunk !== 'function') written += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof enc === 'string' ? enc : 'utf8'); };
    const origWrite = res.write;
    const origEnd = res.end;
    res.write = function w(chunk, ...rest) { count(chunk, rest[0]); return origWrite.call(this, chunk, ...rest); };
    res.end = function e(chunk, ...rest) { count(chunk, rest[0]); return origEnd.call(this, chunk, ...rest); };
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      if (res.statusCode !== 200 && res.statusCode !== 206) return;
      const cl = Number(res.getHeader('content-length'));
      const complete = res.writableFinished || (Number.isFinite(cl) && cl > 0 ? written >= cl : res.writableEnded);
      if (!complete) return;
      const partial = res.statusCode === 206;
      // bytes of the file sent: the range length for 206, else the whole file (a base64 JSON body is larger)
      this.emit('downloaded', doc, via, { status: res.statusCode, range: partial ? (res.getHeader('content-range') || null) : null, bytes: partial ? cl : doc.size });
    };
    res.once('finish', settle);
    res.once('close', settle);
  }

  async list() {
    const docs = await this.repo.list('files');
    for (const d of docs) if (d.status === 'pending') await this.reconcile(d);
    return docs.filter((d) => d.status !== 'pending').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async get(id) {
    const doc = await this.repo.get('files', id);
    if (!doc) return null;
    if (doc.status === 'pending') return (await this.reconcile(doc)) ? this.repo.get('files', id) : null;
    return doc;
  }

  async mustGet(id) {
    const doc = await this.get(id);
    if (!doc) throw new HttpError(404, `File ${id} not found`, { code: 'file-not-found' });
    return doc;
  }

  // A presigned S3 PUT finishes outside the app; fill in size when the object shows up.
  async reconcile(doc) {
    const st = await this.store.stat(doc.id);
    if (!st) return false;
    const now = new Date().toISOString();
    const done = { ...doc, size: st.size, sha256: doc.sha256 || null, status: undefined, updatedAt: now };
    delete done.status;
    await this.repo.put('files', doc.id, done);
    this.emit('uploaded', done, 'presigned'); // a presigned PUT straight to S3 is noticed here
    return true;
  }

  async meta(id, { name, contentType, source, size, sha256, extra }) {
    const now = new Date().toISOString();
    const existing = await this.repo.get('files', id);
    const doc = {
      id,
      name: safeName(name),
      contentType: contentType || guessType(name),
      size,
      sha256,
      source: source || 'uploaded',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      ...(extra || {}),
    };
    await this.repo.put('files', id, doc);
    return doc;
  }

  async saveStream({ id, name, contentType, source, stream }) {
    const fid = id || this.newId();
    const ct = contentType && contentType !== 'application/octet-stream' ? contentType : guessType(name, contentType || 'application/octet-stream');
    const r = await this.store.writeStream(fid, stream, { maxBytes: this.maxBytes(), contentType: ct });
    return this.meta(fid, { name, contentType: ct, source, size: r.size, sha256: r.sha256 });
  }

  async saveBuffer({ id, name, contentType, source, buffer }) {
    if (buffer.length > this.maxBytes()) {
      throw new HttpError(413, `File exceeds the maximum size of ${this.settings.get('maxFileSizeMb')} MB`, { code: 'file-too-large' });
    }
    const fid = id || this.newId();
    const ct = contentType || guessType(name);
    const r = await this.store.writeBuffer(fid, buffer, { contentType: ct });
    return this.meta(fid, { name, contentType: ct, source, size: r.size, sha256: r.sha256 });
  }

  async createPending({ id, name, contentType }) {
    const fid = id || this.newId();
    return this.meta(fid, { name, contentType, source: 'uploaded', size: null, sha256: null, extra: { status: 'pending' } });
  }

  async read(doc, range) { return this.store.read(doc.id, range); }

  async readBuffer(doc) { return this.store.readBuffer(doc.id); }

  async remove(id) {
    const doc = await this.repo.get('files', id);
    if (!doc) return false;
    await this.store.delete(id);
    await this.repo.del('files', id);
    return true;
  }

  static fromBuffer(buf) { return Readable.from([buf]); }
}

module.exports = { FileService, createStore, guessType, safeName };
