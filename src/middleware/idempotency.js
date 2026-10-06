'use strict';
// Idempotency-Key for POST: a replay returns the stored response (Idempotent-Replayed: true);
// the same key with a different request body/path returns 409.
const crypto = require('node:crypto');
const { sendProblem } = require('../util/problem');

const KEEP_HEADERS = ['content-type', 'location', 'etag'];
const TTL_MS = 24 * 3600 * 1000;

module.exports = function idempotency(ctx) {
  const pending = new Map();
  const recent = new Map(); // in-process copy so an immediate retry never races the DB write
  return async function idem(req, res, next) {
    if (req.method !== 'POST') return next();
    const key = req.get('idempotency-key');
    if (key === undefined) return next();
    if (!key || key.length > 255) return sendProblem(req, res, 400, { detail: 'Idempotency-Key must be 1-255 characters' });

    const scope = req.auth?.principal || 'anon';
    const id = crypto.createHash('sha256').update(`${scope}|${key}`).digest('hex');
    const fp = crypto.createHash('sha256')
      .update(`${req.method} ${req.originalUrl.split('?')[0]}\n`)
      .update(Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0))
      .digest('hex');

    if (pending.has(id)) {
      return sendProblem(req, res, 409, { detail: 'A request with this Idempotency-Key is still being processed', code: 'idempotency-in-progress' });
    }
    const existing = recent.get(id) || await ctx.repo.get('idempotency', id);
    if (existing && existing.storedAt + TTL_MS > Date.now()) {
      if (existing.fp !== fp) {
        return sendProblem(req, res, 409, {
          detail: 'Idempotency-Key was already used with a different request',
          code: 'idempotency-key-reuse',
        });
      }
      for (const [k, v] of Object.entries(existing.headers || {})) res.setHeader(k, v);
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(existing.status);
      return res.send(existing.body === null ? undefined : Buffer.from(existing.body, 'base64'));
    }

    pending.set(id, true);
    let captured = null;
    const origSend = res.send.bind(res);
    res.send = function idemSend(body) {
      res.send = origSend;
      if (body !== undefined && body !== null) {
        captured = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      }
      return origSend(body);
    };
    res.on('close', () => pending.delete(id));
    res.on('finish', async () => {
      pending.delete(id);
      if (res.statusCode >= 500 || res.get('X-Chaos-Injected')) return;
      const headers = {};
      for (const h of KEEP_HEADERS) if (res.get(h)) headers[h] = res.get(h);
      const record = { fp, status: res.statusCode, headers, body: captured ? captured.toString('base64') : null, storedAt: Date.now() };
      recent.set(id, record);
      if (recent.size > 2000) recent.delete(recent.keys().next().value);
      try { await ctx.repo.put('idempotency', id, record); } catch { /* best effort */ }
    });
    next();
  };
};
