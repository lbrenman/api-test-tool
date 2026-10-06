'use strict';
// Request inspector (webhook.site style): capture, store (with retention), live events, rules, replay, forward.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const MAX_STORED_BODY = 1024 * 1024; // bytes kept per captured body
const MAX_PART_INLINE = 512 * 1024;
const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection']);

function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      claims: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
    };
  } catch {
    return null;
  }
}

function detectAuth(headers, query) {
  const out = {};
  const authz = headers.authorization;
  if (authz) {
    const [scheme, ...rest] = authz.split(' ');
    const cred = rest.join(' ').trim();
    out.scheme = scheme;
    if (/^basic$/i.test(scheme)) {
      const dec = Buffer.from(cred, 'base64').toString('utf8');
      const i = dec.indexOf(':');
      out.basic = { username: i >= 0 ? dec.slice(0, i) : dec, passwordLength: i >= 0 ? dec.length - i - 1 : 0 };
    } else if (/^bearer$/i.test(scheme)) {
      const jwt = decodeJwt(cred);
      if (jwt) {
        out.jwt = jwt;
        if (jwt.claims.exp) out.jwt.expiresAt = new Date(jwt.claims.exp * 1000).toISOString();
      } else out.bearer = { length: cred.length, preview: `${cred.slice(0, 6)}…` };
    } else if (/^hmac$/i.test(scheme)) {
      const [keyId] = cred.split(':');
      out.hmac = { keyId };
    }
  }
  const keyHeaders = Object.keys(headers).filter((h) => /api[-_]?key|apikey|subscription-key|ocp-apim|x-auth-token|x-access-token/i.test(h));
  if (keyHeaders.length) out.apiKey = keyHeaders.map((h) => ({ in: 'header', name: h, length: String(headers[h]).length }));
  const keyQuery = Object.keys(query || {}).filter((q) => /^(api[-_]?key|apikey|key|access_token|token|code)$/i.test(q));
  if (keyQuery.length) out.apiKey = [...(out.apiKey || []), ...keyQuery.map((q) => ({ in: 'query', name: q, length: String(query[q]).length }))];
  if (headers.cookie) out.cookies = headers.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
  return Object.keys(out).length ? out : null;
}

function describeBody(contentType, buf) {
  const ct = String(contentType || '').toLowerCase();
  if (!buf || !buf.length) return { kind: 'empty', size: 0 };
  const size = buf.length;
  const kept = buf.subarray(0, MAX_STORED_BODY);
  const truncated = size > MAX_STORED_BODY;
  const base = { size, truncated, base64: kept.toString('base64') };
  if (ct.includes('json')) {
    const text = kept.toString('utf8');
    try { return { ...base, kind: 'json', text, pretty: JSON.stringify(JSON.parse(text), null, 2) }; } catch { return { ...base, kind: 'json', text, parseError: 'Invalid JSON' }; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const text = kept.toString('utf8');
    return { ...base, kind: 'form', text, fields: Object.fromEntries(new URLSearchParams(text)) };
  }
  if (ct.includes('xml')) return { ...base, kind: 'xml', text: kept.toString('utf8') };
  if (ct.startsWith('multipart/')) return { ...base, kind: 'multipart' };
  if (ct.startsWith('text/') || ct.includes('javascript') || ct.includes('yaml') || ct.includes('csv')) return { ...base, kind: 'text', text: kept.toString('utf8') };
  // Sniff: printable UTF-8 is shown as text.
  const sample = kept.subarray(0, 4096).toString('utf8');
  if (!ct && !/[\u0000-\u0008\u000e-\u001f]/.test(sample) && !sample.includes('�')) {
    const text = kept.toString('utf8');
    try { return { ...base, kind: 'json', text, pretty: JSON.stringify(JSON.parse(text), null, 2) }; } catch { return { ...base, kind: 'text', text }; }
  }
  return { ...base, kind: 'binary', hex: kept.subarray(0, 512).toString('hex').replace(/(..)/g, '$1 ').trim() };
}

async function parseMultipart(headers, buf) {
  const Busboy = require('busboy');
  return new Promise((resolve) => {
    const parts = [];
    let bb;
    try { bb = Busboy({ headers }); } catch (e) { resolve({ error: e.message, parts }); return; }
    bb.on('field', (name, value, info) => parts.push({ type: 'field', name, value, contentType: info.mimeType }));
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const data = Buffer.concat(chunks);
        parts.push({
          type: 'file', name, filename: info.filename, contentType: info.mimeType, size: data.length,
          base64: data.length <= MAX_PART_INLINE ? data.toString('base64') : null,
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
        });
      });
    });
    bb.on('error', (e) => resolve({ error: e.message, parts }));
    bb.on('close', () => resolve({ parts }));
    bb.end(buf);
  });
}

function patternToRegex(pattern) {
  const p = String(pattern || '');
  if (p.startsWith('/') && p.length > 2 && p.endsWith('/') && /[\\^$()|+?[\]]/.test(p.slice(1, -1))) {
    try { return { re: new RegExp(p.slice(1, -1)), names: [] }; } catch { /* treat as literal */ }
  }
  const names = [];
  let src = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') { src += p[i + 1] === '*' ? '.*' : '[^/]*'; if (p[i + 1] === '*') i++; } else if (c === '{') {
      const j = p.indexOf('}', i);
      names.push(p.slice(i + 1, j));
      src += '([^/]+)';
      i = j;
    } else src += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return { re: new RegExp(`^${src}/?$`), names };
}

function render(template, vars) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
    if (key === 'uuid') return crypto.randomUUID();
    if (key === 'now') return new Date().toISOString();
    if (key === 'nowEpoch') return String(Math.floor(Date.now() / 1000));
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), vars);
    return v === undefined || v === null ? '' : String(v);
  });
}

function summary(e) {
  return {
    id: e.id, ts: e.ts, method: e.method, path: e.path, query: e.query, kind: e.kind, ip: e.ip,
    contentType: e.headers['content-type'] || null, size: e.body?.size || 0,
    status: e.response?.status ?? null, durationMs: e.durationMs ?? null, authScheme: e.auth?.scheme || (e.auth?.apiKey ? 'api-key' : null),
    rule: e.response?.rule ?? null, aborted: e.response?.aborted || false, forwarded: e.forward ? e.forward.status ?? 'error' : null,
  };
}

class InspectorService extends EventEmitter {
  constructor(ctx) {
    super();
    this.setMaxListeners(100);
    this.ctx = ctx;
    this.seq = 0;
  }

  async capture(req, rawBody, kind = 'catch-all') {
    const entry = await this.build(req, rawBody, kind);
    await this.save(entry);
    await this.ctx.repo.trim('inspector', this.ctx.settings.get('inspectorRetention'));
    this.emit('request', summary(entry));
    return entry;
  }

  // One-shot capture of API traffic (/v1, /oauth) once its response is done (or the connection dropped).
  async record(req, rawBody, kind, response) {
    const entry = await this.build(req, rawBody, kind);
    const { durationMs, aborted, startedAt, ip, ...res } = response;
    if (ip && !entry.ip) entry.ip = ip;
    if (startedAt) entry.ts = new Date(startedAt).toISOString();
    entry.response = {
      status: res.status,
      headers: res.headers,
      rule: null,
      aborted: !!aborted,
      body: res.body && res.body.length ? describeBody(res.contentType || res.headers?.['content-type'], res.body) : null,
    };
    entry.durationMs = durationMs;
    await this.save(entry);
    await this.ctx.repo.trim('inspector', this.ctx.settings.get('inspectorRetention'));
    this.emit('request', summary(entry));
    return entry;
  }

  async build(req, rawBody, kind) {
    const url = new URL(req.originalUrl, this.ctx.baseUrl(req));
    const headers = { ...req.headers };
    const ct = headers['content-type'];
    const body = describeBody(ct, rawBody);
    if (body.kind === 'multipart') body.multipart = await parseMultipart(req.headers, rawBody);
    const entry = {
      id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      ts: new Date().toISOString(),
      kind,
      method: req.method,
      url: url.toString(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      rawQuery: url.search,
      headers,
      rawHeaders: req.rawHeaders,
      httpVersion: req.httpVersion,
      ip: req.ip,
      ips: req.ips,
      auth: detectAuth(headers, Object.fromEntries(url.searchParams)),
      body,
      requestId: req.id,
    };
    // File uploads stream straight to the file store; note the size instead of the bytes.
    const declared = Number(headers['content-length']) || 0;
    if (body.kind === 'empty' && kind !== 'catch-all' && (declared > 0 || headers['transfer-encoding'])) {
      entry.body = { kind: 'streamed', size: declared };
    }
    return entry;
  }

  async complete(entry, { status, headers, body, contentType, rule, durationMs }) {
    entry.response = {
      status,
      headers,
      rule: rule ?? null,
      body: body === undefined || body === null ? null : describeBody(contentType || headers?.['content-type'], Buffer.isBuffer(body) ? body : Buffer.from(String(body))),
    };
    entry.durationMs = durationMs;
    await this.save(entry);
    this.emit('update', summary(entry));
  }

  async save(entry) {
    await this.ctx.repo.put('inspector', entry.id, entry);
  }

  async list(limit = 200) {
    const n = Math.min(limit, this.ctx.settings.get('inspectorRetention'));
    return (await this.ctx.repo.list('inspector', { order: 'desc', limit: n })).map(summary);
  }

  async get(id) { return this.ctx.repo.get('inspector', id); }

  async exportAll() { return this.ctx.repo.list('inspector', { order: 'desc', limit: this.ctx.settings.get('inspectorRetention') }); }

  async clear() {
    await this.ctx.repo.clear('inspector');
    this.emit('clear', {});
  }

  // Decide the catch-all response: first matching rule, else the configured default.
  resolveResponse(req, entry) {
    const s = this.ctx.settings;
    const rules = Array.isArray(s.get('inspectorRules')) ? s.get('inspectorRules') : [];
    const path = entry.path;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule || rule.enabled === false) continue;
      if (rule.method && String(rule.method).toUpperCase() !== 'ANY' && String(rule.method).toUpperCase() !== req.method) continue;
      const { re, names } = patternToRegex(rule.path || '/**');
      const m = re.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(names.map((n, j) => [n, decodeURIComponent(m[j + 1])]));
      let reqJson = null;
      if (entry.body?.kind === 'json' && entry.body.text) { try { reqJson = JSON.parse(entry.body.text); } catch { /* ignore */ } }
      const vars = { params, query: entry.query, method: req.method, path, id: entry.id, body: reqJson, baseUrl: this.ctx.baseUrl(req) };
      const headers = {};
      for (const h of (Array.isArray(rule.headers) ? rule.headers : Object.entries(rule.headers || {}).map(([name, value]) => ({ name, value })))) {
        headers[h.name] = render(String(h.value), vars);
      }
      const body = rule.body === undefined || rule.body === null ? '' : typeof rule.body === 'string' ? render(rule.body, vars) : render(JSON.stringify(rule.body), vars);
      return {
        status: Number(rule.status) || 200,
        contentType: rule.contentType || (typeof rule.body === 'object' ? 'application/json' : 'text/plain; charset=utf-8'),
        headers,
        body,
        delayMs: Number(rule.delayMs) || 0,
        rule: rule.name || `rule ${i + 1}`,
      };
    }
    const headers = {};
    for (const h of s.get('inspectorResponseHeaders')) headers[h.name] = h.value;
    const configured = s.get('inspectorResponseBody');
    const body = configured
      ? render(configured, { id: entry.id, method: req.method, path, query: entry.query, baseUrl: this.ctx.baseUrl(req) })
      : JSON.stringify({ status: 'captured', id: entry.id, method: req.method, path, receivedAt: entry.ts, inspector: `${this.ctx.baseUrl(req)}/dashboard#/inspector/${entry.id}` });
    return {
      status: s.get('inspectorResponseStatus'),
      contentType: configured ? s.get('inspectorResponseContentType') : 'application/json',
      headers,
      body,
      delayMs: s.get('inspectorResponseDelayMs'),
      rule: null,
    };
  }

  static outboundHeaders(headers, extra = {}) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (HOP.has(k.toLowerCase()) || k.startsWith(':')) continue;
      out[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    return { ...out, ...extra };
  }

  static entryBody(entry) {
    if (!entry.body || entry.body.kind === 'empty' || !entry.body.base64) return undefined;
    return Buffer.from(entry.body.base64, 'base64');
  }

  async send(method, url, headers, body, timeoutMs = 30000) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body, redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const h = Object.fromEntries(res.headers.entries());
      return { url, status: res.status, headers: h, body: describeBody(h['content-type'], buf), durationMs: Date.now() - started };
    } catch (e) {
      return { url, error: e.cause?.message || e.message, durationMs: Date.now() - started };
    }
  }

  async replay(entry, targetUrl, req) {
    const base = targetUrl ? String(targetUrl) : this.ctx.baseUrl(req);
    const url = targetUrl && /^https?:\/\/[^/]+\/./.test(targetUrl) && !targetUrl.endsWith('/') ? targetUrl : `${base.replace(/\/+$/, '')}${entry.path}${entry.rawQuery || ''}`;
    return this.send(entry.method, url, InspectorService.outboundHeaders(entry.headers, { 'X-Replayed-From': entry.id }), InspectorService.entryBody(entry));
  }

  async forward(entry) {
    const s = this.ctx.settings;
    if (!s.get('inspectorForwardEnabled') || !s.get('inspectorForwardUrl')) return;
    const url = `${s.get('inspectorForwardUrl').replace(/\/+$/, '')}${entry.path}${entry.rawQuery || ''}`;
    entry.forward = await this.send(entry.method, url, InspectorService.outboundHeaders(entry.headers, { 'X-Forwarded-By': 'api-test-tool', 'X-Inspector-Id': entry.id }), InspectorService.entryBody(entry));
    await this.save(entry);
    this.emit('update', summary(entry));
  }

  toCurl(entry, targetBase) {
    const url = targetBase ? `${targetBase.replace(/\/+$/, '')}${entry.path}${entry.rawQuery || ''}` : entry.url;
    const parts = [`curl -X ${entry.method} '${url.replace(/'/g, "'\\''")}'`];
    for (const [k, v] of Object.entries(InspectorService.outboundHeaders(entry.headers))) parts.push(`  -H '${`${k}: ${v}`.replace(/'/g, "'\\''")}'`);
    const b = entry.body;
    if (b && b.kind !== 'empty') {
      if (['json', 'text', 'xml', 'form'].includes(b.kind) && !b.truncated) parts.push(`  --data-binary '${String(b.text).replace(/'/g, "'\\''")}'`);
      else parts.push('  --data-binary @body.bin   # binary/multipart body: download it from the inspector');
    }
    return parts.join(' \\\n');
  }
}

module.exports = { InspectorService, detectAuth, describeBody, patternToRegex, render, summary };
