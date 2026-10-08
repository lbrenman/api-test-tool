'use strict';
// /v1/files — one shared pool, many transfer protocols:
// multipart, raw, base64-in-JSON, tus resumable, presigned URLs, range download, chunked download.
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { HttpError } = require('../util/problem');
const { applyQuery, parseFields, project } = require('../services/query');
const { paginate } = require('../services/paginate');
const { meter } = require('../services/fileStore/meter');
const { safeName } = require('../services/files');

const TUS_VERSION = '1.0.0';

function contentDisposition(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function filenameFromDisposition(h) {
  if (!h) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(h);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* fallthrough */ } }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(h);
  return plain ? plain[1].trim() : null;
}

function parseTusMetadata(h) {
  const out = {};
  for (const pair of String(h || '').split(',')) {
    const [k, v] = pair.trim().split(' ');
    if (!k) continue;
    out[k] = v ? Buffer.from(v, 'base64').toString('utf8') : '';
  }
  return out;
}

function fileLinks(base, f) {
  return {
    self: `${base}/v1/files/${f.id}`,
    download: `${base}/v1/files/${f.id}/download`,
    chunked: `${base}/v1/files/${f.id}/chunked`,
    base64: `${base}/v1/files/${f.id}/base64`,
  };
}

module.exports = function filesRouter(ctx) {
  const { files, baseUrl, repo, settings, dates } = ctx;
  const r = express.Router();
  const tusDir = path.resolve(path.dirname(path.resolve(settings.get('fileDir'))), 'tus');

  const present = (req, f) => dates.formatDoc({ ...f, links: fileLinks(baseUrl(req), f) });

  // ---------- presign secret (local store) ----------
  let presignKey = null;
  async function presignSecret() {
    if (!presignKey) {
      let s = await repo.kvGet('presign:secret');
      if (!s) { s = crypto.randomBytes(32).toString('base64url'); await repo.kvSet('presign:secret', s); }
      presignKey = s;
    }
    return presignKey;
  }
  async function signToken(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', await presignSecret()).update(body).digest('base64url');
    return `${body}.${sig}`;
  }
  async function verifyToken(token) {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) throw new HttpError(403, 'Malformed presigned token', { code: 'invalid-signature' });
    const expect = crypto.createHmac('sha256', await presignSecret()).update(body).digest('base64url');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      throw new HttpError(403, 'Invalid presigned URL signature', { code: 'invalid-signature' });
    }
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p.e * 1000 < Date.now()) throw new HttpError(403, 'Presigned URL has expired', { code: 'expired' });
    return p;
  }

  // ---------- download helper (range, etag, conditional) ----------
  async function sendFile(req, res, f, { inline, attachment = true, via = 'download' } = {}) {
    const size = f.size;
    const etag = `"${f.sha256 || `${f.id}-${size}`}"`;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(f.updatedAt).toUTCString());
    res.setHeader('Content-Type', f.contentType);
    if (attachment || inline) res.setHeader('Content-Disposition', contentDisposition(f.name, inline));
    const inm = req.get('if-none-match');
    if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(etag)) return res.status(304).end();

    let start;
    let end;
    const range = req.get('range');
    const ifRange = req.get('if-range');
    if (range && (!ifRange || ifRange === etag || ifRange === res.get('Last-Modified'))) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.split(',')[0].trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        res.setHeader('Content-Range', `bytes */${size}`);
        throw new HttpError(416, `Unsupported or invalid Range "${range}"`);
      }
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
      if (start >= size || start > end) {
        res.setHeader('Content-Range', `bytes */${size}`);
        throw new HttpError(416, `Range ${range} is not satisfiable for a ${size}-byte file`);
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
    } else {
      res.setHeader('Content-Length', String(size));
    }
    if (req.method === 'HEAD') return res.end();
    files.trackDownload(req, res, f, via);
    const stream = await files.read(f, start !== undefined ? { start, end } : undefined);
    await pipeline(stream, res);
  }

  // ---------- list / metadata / delete ----------
  r.get('/', async (req, res) => {
    const list = applyQuery(await files.list(), req.query, { parseDate: dates.parseValue, ignore: [ctx.settings.get('apiKeyName')] });
    const fields = parseFields(req.query.fields);
    const { body } = paginate('offset', req, list, { baseUrl, name: 'files', render: (s) => s.map((f) => project(present(req, f), fields)) });
    res.json(body);
  });

  // ---------- multipart ----------
  r.post('/multipart', async (req, res) => {
    const ct = req.get('content-type') || '';
    if (!/^multipart\/form-data/i.test(ct)) throw new HttpError(415, 'Content-Type must be multipart/form-data');
    const Busboy = require('busboy');
    const fields = {};
    const saves = [];
    let failure = null;
    const bb = Busboy({ headers: req.headers, limits: { fileSize: files.maxBytes() + 1, files: 20, fields: 200 } });
    await new Promise((resolve, reject) => {
      bb.on('field', (name, val) => {
        if (name in fields) fields[name] = [].concat(fields[name], val); else fields[name] = val;
      });
      bb.on('file', (field, stream, info) => {
        const p = files.saveStream({ name: info.filename || `${field}.bin`, contentType: info.mimeType, source: 'uploaded', stream })
          .then((meta) => ({ field, meta }))
          .catch((e) => { failure = failure || e; stream.resume(); return null; });
        saves.push(p);
      });
      bb.on('error', reject);
      bb.on('close', resolve);
      req.pipe(bb);
    });
    const saved = (await Promise.all(saves)).filter(Boolean);
    if (failure) {
      for (const s of saved) await files.remove(s.meta.id);
      throw failure;
    }
    if (!saved.length) throw new HttpError(400, 'No file parts found in the multipart body', { code: 'no-files' });
    for (const s of saved) files.emit('uploaded', s.meta, 'multipart');
    res.setHeader('Location', `${baseUrl(req)}/v1/files/${saved[0].meta.id}`);
    res.status(201).json({
      files: saved.map((s) => ({ field: s.field, ...present(req, s.meta) })),
      fields,
    });
  });

  // ---------- raw ----------
  async function rawUpload(req, res, name) {
    if (!req.readable) throw new HttpError(400, 'Request body already consumed');
    const meta = await files.saveStream({
      name: name || 'upload.bin',
      contentType: (req.get('content-type') || 'application/octet-stream').split(';')[0],
      source: 'uploaded',
      stream: req,
    });
    if (!meta.size) {
      await files.remove(meta.id);
      throw new HttpError(400, 'Empty request body', { code: 'empty-body' });
    }
    files.emit('uploaded', meta, 'raw');
    res.setHeader('Location', `${baseUrl(req)}/v1/files/${meta.id}`);
    res.status(201).json(present(req, meta));
  }
  r.put('/raw/:name', (req, res) => rawUpload(req, res, req.params.name));
  r.post('/raw', (req, res) => rawUpload(req, res, filenameFromDisposition(req.get('content-disposition')) || req.get('x-filename') || req.query.name));

  // ---------- base64 ----------
  r.post('/base64', async (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object') throw new HttpError(400, 'JSON body {name, contentType?, data} required');
    const errors = [];
    if (!b.name || typeof b.name !== 'string') errors.push({ field: 'name', message: 'is required' });
    if (!b.data || typeof b.data !== 'string') errors.push({ field: 'data', message: 'is required (base64 string or data: URL)' });
    if (errors.length) throw new HttpError(422, 'Invalid base64 upload', { errors });
    let data = b.data;
    let contentType = b.contentType;
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(data);
    if (m) { contentType = contentType || m[1]; data = m[3]; }
    const clean = data.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new HttpError(422, 'data is not valid base64', { errors: [{ field: 'data', message: 'not valid base64' }] });
    const buffer = Buffer.from(clean.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const meta = await files.saveBuffer({ name: b.name, contentType, source: 'uploaded', buffer });
    files.emit('uploaded', meta, 'base64');
    res.setHeader('Location', `${baseUrl(req)}/v1/files/${meta.id}`);
    res.status(201).json(present(req, meta));
  });

  // ---------- tus 1.0.0 (core + creation, creation-with-upload, termination) ----------
  function tusHeaders(res) {
    res.setHeader('Tus-Resumable', TUS_VERSION);
    res.setHeader('Cache-Control', 'no-store');
  }
  function requireTus(req) {
    if (req.get('tus-resumable') !== TUS_VERSION) {
      throw new HttpError(412, `Tus-Resumable: ${TUS_VERSION} header required`, { headers: { 'Tus-Version': TUS_VERSION } });
    }
  }
  async function tusAppend(req, upload) {
    await fsp.mkdir(tusDir, { recursive: true });
    const file = path.join(tusDir, upload.id);
    const remaining = upload.length - upload.offset;
    const m = meter(remaining);
    try {
      await pipeline(req, m.stream, fs.createWriteStream(file, { flags: 'a' }));
    } catch (e) {
      // Keep whatever made it to disk (resumability); recompute offset from the file.
      if (!(e instanceof HttpError)) { /* client disconnect */ } else if (e.status === 413) {
        const st = await fsp.stat(file).catch(() => ({ size: upload.offset }));
        upload.offset = Math.min(st.size, upload.length);
        await repo.put('tus_uploads', upload.id, upload);
        throw new HttpError(413, 'Chunk exceeds the declared Upload-Length');
      }
    }
    const st = await fsp.stat(file).catch(() => ({ size: upload.offset }));
    upload.offset = st.size;
    upload.updatedAt = new Date().toISOString();
    if (upload.offset >= upload.length && !upload.fileId) {
      const meta = await files.saveStream({
        name: upload.metadata.filename || upload.metadata.name || 'tus-upload.bin',
        contentType: upload.metadata.filetype || upload.metadata.contentType || 'application/octet-stream',
        source: 'uploaded',
        stream: fs.createReadStream(file),
      });
      upload.fileId = meta.id;
      await fsp.rm(file, { force: true });
      files.emit('uploaded', meta, 'tus');
    }
    await repo.put('tus_uploads', upload.id, upload);
    return upload;
  }
  function tusProgress(req, res, upload) {
    res.setHeader('Upload-Offset', String(upload.offset));
    if (upload.fileId) {
      res.setHeader('X-File-Id', upload.fileId);
      res.setHeader('Link', `<${baseUrl(req)}/v1/files/${upload.fileId}>; rel="file"`);
    }
  }

  r.options('/tus', (req, res) => {
    tusHeaders(res);
    res.setHeader('Tus-Version', TUS_VERSION);
    res.setHeader('Tus-Extension', 'creation,creation-with-upload,termination');
    res.setHeader('Tus-Max-Size', String(files.maxBytes()));
    res.status(204).end();
  });
  r.options('/tus/:uploadId', (req, res) => {
    tusHeaders(res);
    res.setHeader('Tus-Version', TUS_VERSION);
    res.setHeader('Tus-Extension', 'creation,creation-with-upload,termination');
    res.status(204).end();
  });

  r.post('/tus', async (req, res) => {
    tusHeaders(res);
    requireTus(req);
    if (req.get('upload-defer-length')) throw new HttpError(400, 'Upload-Defer-Length is not supported');
    const length = Number(req.get('upload-length'));
    if (!Number.isInteger(length) || length < 0) throw new HttpError(400, 'Upload-Length header (non-negative integer) required');
    if (length > files.maxBytes()) throw new HttpError(413, `Upload-Length exceeds the maximum of ${settings.get('maxFileSizeMb')} MB`, { code: 'file-too-large' });
    const id = crypto.randomBytes(12).toString('base64url');
    let upload = {
      id, length, offset: 0, metadata: parseTusMetadata(req.get('upload-metadata')), fileId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await fsp.mkdir(tusDir, { recursive: true });
    await fsp.writeFile(path.join(tusDir, id), Buffer.alloc(0));
    await repo.put('tus_uploads', id, upload);
    const hasBody = Number(req.get('content-length') || 0) > 0 || !!req.get('transfer-encoding');
    if (hasBody) {
      if ((req.get('content-type') || '') !== 'application/offset+octet-stream') throw new HttpError(415, 'creation-with-upload requires Content-Type: application/offset+octet-stream');
      upload = await tusAppend(req, upload);
    } else if (length === 0) {
      upload = await tusAppend(Readable.from([]), upload);
    }
    res.setHeader('Location', `${baseUrl(req)}/v1/files/tus/${id}`);
    tusProgress(req, res, upload);
    res.status(201).end();
  });

  async function loadUpload(req) {
    const u = await repo.get('tus_uploads', req.params.uploadId);
    if (!u) throw new HttpError(404, 'Upload not found');
    return u;
  }

  r.head('/tus/:uploadId', async (req, res) => {
    tusHeaders(res);
    requireTus(req);
    const u = await loadUpload(req);
    res.setHeader('Upload-Length', String(u.length));
    const meta = Object.entries(u.metadata || {}).map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`).join(',');
    if (meta) res.setHeader('Upload-Metadata', meta);
    tusProgress(req, res, u);
    res.status(200).end();
  });

  r.get('/tus/:uploadId', async (req, res) => {
    const u = await loadUpload(req);
    res.json({ id: u.id, length: u.length, offset: u.offset, complete: !!u.fileId, fileId: u.fileId, metadata: u.metadata });
  });

  r.patch('/tus/:uploadId', async (req, res) => {
    tusHeaders(res);
    requireTus(req);
    if ((req.get('content-type') || '') !== 'application/offset+octet-stream') throw new HttpError(415, 'Content-Type must be application/offset+octet-stream');
    let u = await loadUpload(req);
    const off = Number(req.get('upload-offset'));
    if (!Number.isInteger(off)) throw new HttpError(400, 'Upload-Offset header required');
    if (off !== u.offset) throw new HttpError(409, `Upload-Offset ${off} does not match the current offset ${u.offset}`, { headers: { 'Upload-Offset': String(u.offset) } });
    if (u.fileId) throw new HttpError(409, 'Upload already complete');
    u = await tusAppend(req, u);
    tusProgress(req, res, u);
    res.status(204).end();
  });

  r.delete('/tus/:uploadId', async (req, res) => {
    tusHeaders(res);
    requireTus(req);
    const u = await loadUpload(req);
    await fsp.rm(path.join(tusDir, u.id), { force: true });
    await repo.del('tus_uploads', u.id);
    res.status(204).end();
  });

  // ---------- presigned URLs ----------
  r.post('/presign', async (req, res) => {
    const b = req.body || {};
    const method = String(b.method || 'PUT').toUpperCase();
    if (!['PUT', 'GET'].includes(method)) throw new HttpError(422, 'method must be PUT or GET', { errors: [{ field: 'method', message: 'must be PUT or GET' }] });
    const expiresIn = Math.min(Math.max(Number(b.expiresIn) || 900, 1), 7 * 24 * 3600);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    let fileId;
    let headers = {};
    if (method === 'GET') {
      if (!b.fileId) throw new HttpError(422, 'fileId is required for GET', { errors: [{ field: 'fileId', message: 'is required' }] });
      const f = await files.mustGet(b.fileId);
      fileId = f.id;
      const url = files.store.name === 's3'
        ? await files.store.presign(f.id, { method: 'GET', expiresIn, filename: f.name })
        : `${baseUrl(req)}/v1/files/presigned/${await signToken({ f: f.id, m: 'GET', e: Math.floor(Date.now() / 1000) + expiresIn })}`;
      return res.status(201).json({ method, url, headers, fileId, expiresAt, store: files.store.name });
    }
    if (!b.name) throw new HttpError(422, 'name is required for PUT', { errors: [{ field: 'name', message: 'is required' }] });
    const contentType = b.contentType || 'application/octet-stream';
    const pending = await files.createPending({ name: safeName(b.name), contentType });
    fileId = pending.id;
    headers = { 'Content-Type': contentType };
    const url = files.store.name === 's3'
      ? await files.store.presign(fileId, { method: 'PUT', contentType, expiresIn })
      : `${baseUrl(req)}/v1/files/presigned/${await signToken({ f: fileId, m: 'PUT', e: Math.floor(Date.now() / 1000) + expiresIn, n: pending.name, c: contentType })}`;
    res.status(201).json({ method, url, headers, fileId, expiresAt, store: files.store.name, file: `${baseUrl(req)}/v1/files/${fileId}` });
  });

  // ---------- item routes ----------
  r.get('/:id', async (req, res) => {
    res.json(present(req, await files.mustGet(req.params.id)));
  });

  r.delete('/:id', async (req, res) => {
    const doc = await files.get(req.params.id);
    if (!doc || !(await files.remove(req.params.id))) throw new HttpError(404, `File ${req.params.id} not found`);
    files.emit('deleted', doc, 'api');
    res.status(204).end();
  });

  r.get('/:id/base64', async (req, res) => {
    const f = await files.mustGet(req.params.id);
    const buf = await files.readBuffer(f);
    files.trackDownload(req, res, f, 'base64');
    res.json({ ...present(req, f), encoding: 'base64', data: buf.toString('base64') });
  });

  r.get('/:id/download', async (req, res) => {
    const f = await files.mustGet(req.params.id);
    await sendFile(req, res, f, { inline: req.query.inline === 'true' });
  });

  r.get('/:id/chunked', async (req, res) => {
    const f = await files.mustGet(req.params.id);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', contentDisposition(f.name, req.query.inline === 'true'));
    res.setHeader('X-File-Size', String(f.size));
    res.removeHeader('Content-Length');
    if (req.method === 'HEAD') return res.end();
    files.trackDownload(req, res, f, 'chunked');
    const stream = await files.read(f);
    for await (const chunk of stream) {
      // Write in 64 KiB pieces so even small files produce multiple chunks.
      for (let i = 0; i < chunk.length; i += 65536) {
        if (!res.write(chunk.subarray(i, i + 65536))) await new Promise((r2) => res.once('drain', r2));
      }
    }
    res.end();
  });

  return { router: r, sendFile, verifyToken, present };
};

// Public (unauthenticated) presigned-URL endpoints for the local store, mounted before /v1 auth.
module.exports.presignedRouter = function presignedRouter(ctx, filesApi) {
  const { files, baseUrl } = ctx;
  const r = express.Router();
  r.get('/v1/files/presigned/:token', async (req, res) => {
    const p = await filesApi.verifyToken(req.params.token);
    if (p.m !== 'GET') throw new HttpError(403, 'This presigned URL does not allow GET');
    const f = await files.mustGet(p.f);
    await filesApi.sendFile(req, res, f, { inline: req.query.inline === 'true', via: 'presigned' });
  });
  r.put('/v1/files/presigned/:token', async (req, res) => {
    const p = await filesApi.verifyToken(req.params.token);
    if (p.m !== 'PUT') throw new HttpError(403, 'This presigned URL does not allow PUT');
    const meta = await files.saveStream({
      id: p.f, name: p.n, contentType: (req.get('content-type') || p.c || 'application/octet-stream').split(';')[0], source: 'uploaded', stream: req,
    });
    files.emit('uploaded', meta, 'presigned');
    res.setHeader('Location', `${baseUrl(req)}/v1/files/${meta.id}`);
    res.status(200).json(filesApi.present(req, meta));
  });
  return r;
};
