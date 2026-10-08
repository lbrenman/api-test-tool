'use strict';
// Outgoing webhooks: subscriptions to created / updated / deleted events on the mock data, and to
// uploaded / downloaded / deleted events on the file pool, stored in the database (collection "webhooks",
// so they survive restarts), delivered as a JSON POST.
//
// Every write through ResourceService emits ctx.events 'change' (whatever the protocol: /v1, SOAP, GraphQL,
// OData, the back office); the file routes emit ctx.events 'file' once an upload, download or delete has
// completed (any file protocol, and the dashboard). Each enabled matching webhook gets one delivery:
//
//   POST <url>
//   Content-Type: application/json
//   X-Webhook-Id, X-Webhook-Event (employees.created), X-Webhook-Delivery, X-Webhook-Timestamp,
//   X-Webhook-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>   (when a secret is set)
//   + the webhook's own headers (e.g. an API key for the receiving integration)
//
//   {"id": "<delivery id>", "event": "employees.created", "type": "created", "resource": "employees",
//    "resourceId": 42, "href": "<base>/v1/employees/42", "occurredAt": "…", "webhookId": "…",
//    "data": {…} (only with includeData; never for deletes)}
//   File events: "resource": "files", "resourceId": "f_…", "href": "<base>/v1/files/f_…", plus "via"
//   (multipart, raw, base64, tus, presigned, download, chunked, api, dashboard), "file" {name, contentType,
//   size, sha256, …} and, for downloads, "status" (200/206), "range" and "bytes".
//
// One attempt per event, no automatic retries; every delivery is logged (collection "webhook_deliveries",
// trimmed to WEBHOOK_DELIVERY_RETENTION) and can be resent from the dashboard or the admin API.
const crypto = require('node:crypto');
const { HttpError } = require('../util/problem');
const { NAMES } = require('./resources');
const pkg = require('../../package.json');

const EVENTS = ['created', 'updated', 'deleted', 'uploaded', 'downloaded'];
const DATA_EVENTS = ['created', 'updated', 'deleted'];
const FILE_EVENTS = ['uploaded', 'downloaded', 'deleted'];
const RESOURCES = [...NAMES, 'files']; // "*" means every data resource; the file pool is opted into as "files"
const hasData = (resources) => resources.some((r) => r !== 'files');
const COLL = 'webhooks';
const DELIVERIES = 'webhook_deliveries';
const MAX_BODY_LOG = 8192;
const RESERVED_HEADERS = /^(content-type|content-length|host|connection|transfer-encoding|x-webhook-)/i;

const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const bad = (message, field) => new HttpError(400, message, { code: 'invalid-webhook', errors: field ? [{ field, message }] : undefined });

function sign(secret, timestamp, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

// Validate and normalise a webhook definition. partial: only the fields given are checked (PATCH).
function normalize(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('The body must be a JSON object');
  const out = existing ? { ...existing } : { enabled: true, includeData: false, resources: ['*'], events: null, headers: {}, secret: '' };
  const has = (k) => Object.hasOwn(input, k);
  if (has('name')) {
    if (typeof input.name !== 'string' || input.name.length > 120) throw bad('name must be a string of at most 120 characters', 'name');
    out.name = input.name.trim();
  }
  if (has('url') || !existing) {
    let u;
    try { u = new URL(String(input.url ?? '')); } catch { throw bad('url must be an absolute http(s) URL', 'url'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('url must use http or https', 'url');
    out.url = u.toString();
  }
  if (has('resources')) {
    const list = [].concat(input.resources).map((x) => String(x).trim()).filter(Boolean);
    const wrong = list.filter((x) => x !== '*' && !RESOURCES.includes(x));
    if (!list.length || wrong.length) throw bad(`resources must be "*" (every data resource) and/or any of ${RESOURCES.join(', ')}${wrong.length ? ` (unknown: ${wrong.join(', ')})` : ''}`, 'resources');
    out.resources = list.includes('*') ? ['*', ...(list.includes('files') ? ['files'] : [])] : RESOURCES.filter((r) => list.includes(r));
  }
  if (has('events')) {
    const list = [].concat(input.events).map((x) => String(x).trim()).filter(Boolean);
    const wrong = list.filter((x) => !EVENTS.includes(x));
    if (!list.length || wrong.length) throw bad(`events must be one or more of ${EVENTS.join(', ')}${wrong.length ? ` (unknown: ${wrong.join(', ')})` : ''}`, 'events');
    out.events = EVENTS.filter((e) => list.includes(e));
  }
  // Default events follow the resources: data -> created + updated, files -> uploaded.
  if (!out.events) out.events = EVENTS.filter((e) => (hasData(out.resources) && ['created', 'updated'].includes(e)) || (out.resources.includes('files') && e === 'uploaded'));
  const useless = out.events.filter((e) => !(hasData(out.resources) && DATA_EVENTS.includes(e)) && !(out.resources.includes('files') && FILE_EVENTS.includes(e)));
  if (useless.length) {
    throw bad(`${useless.join(', ')} never happen${useless.length === 1 ? 's' : ''} for ${out.resources.join(', ').replace('*', 'the data resources')}: created/updated are data events, uploaded/downloaded are file events (deleted is both)`, 'events');
  }
  for (const k of ['enabled', 'includeData']) {
    if (has(k)) {
      if (typeof input[k] !== 'boolean') throw bad(`${k} must be true or false`, k);
      out[k] = input[k];
    }
  }
  if (has('secret')) {
    if (input.secret !== null && (typeof input.secret !== 'string' || input.secret.length > 256)) throw bad('secret must be a string of at most 256 characters (or null to remove it)', 'secret');
    out.secret = input.secret || '';
  }
  if (has('headers')) {
    const hdrs = input.headers ?? {};
    if (typeof hdrs !== 'object' || Array.isArray(hdrs)) throw bad('headers must be an object of name: value', 'headers');
    const clean = {};
    for (const [k, v] of Object.entries(hdrs)) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) throw bad(`"${k}" is not a valid header name`, `headers.${k}`);
      if (RESERVED_HEADERS.test(k)) throw bad(`"${k}" is set by the tool and cannot be overridden`, `headers.${k}`);
      if (typeof v !== 'string' || /[\r\n]/.test(v) || v.length > 2048) throw bad(`headers.${k} must be a single-line string`, `headers.${k}`);
      clean[k] = v;
    }
    out.headers = clean;
  }
  if (!out.name) out.name = `${out.resources.join(', ')} ${out.events.join('/')}`.replace('*', 'all data');
  return out;
}

// Secrets are write-only through the API: shown as a flag and the last 4 characters.
function publicView(hook) {
  const { secret, ...rest } = hook;
  return { ...rest, hasSecret: !!secret, secretHint: secret && secret.length >= 12 ? `…${secret.slice(-4)}` : null };
}

class WebhookService {
  constructor(ctx) {
    this.ctx = ctx;
    this.hooks = new Map();
    this.pending = new Set(); // in-flight deliveries (awaited by drain(), e.g. in tests and on shutdown)
  }

  async init() {
    for (const h of await this.ctx.repo.list(COLL)) this.hooks.set(h.id, h);
    this.ctx.events.on('change', (e) => this.onChange(e));
    this.ctx.events.on('file', (e) => this.onChange(e));
  }

  list() { return [...this.hooks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(publicView); }

  get(id) {
    const h = this.hooks.get(id);
    if (!h) throw new HttpError(404, `Webhook ${id} not found`, { code: 'not-found' });
    return h;
  }

  async create(input, baseUrl) {
    const now = new Date().toISOString();
    const hook = { id: newId('wh'), ...normalize(input), baseUrl, createdAt: now, updatedAt: now, lastDelivery: null };
    await this.ctx.repo.put(COLL, hook.id, hook);
    this.hooks.set(hook.id, hook);
    return publicView(hook);
  }

  async update(id, input, baseUrl) {
    const current = this.get(id);
    const hook = { ...normalize(input, current), baseUrl: baseUrl || current.baseUrl, updatedAt: new Date().toISOString() };
    await this.ctx.repo.put(COLL, id, hook);
    this.hooks.set(id, hook);
    return publicView(hook);
  }

  async remove(id) {
    this.get(id);
    await this.ctx.repo.del(COLL, id);
    this.hooks.delete(id);
  }

  matches(hook, e) {
    if (!hook.enabled || !hook.events.includes(e.type)) return false;
    if (e.resource === 'files') return hook.resources.includes('files');
    return hook.resources.includes('*') || hook.resources.includes(e.resource);
  }

  onChange(e) {
    if (!this.ctx.settings.get('webhooksEnabled')) return;
    for (const hook of this.hooks.values()) {
      if (this.matches(hook, e)) this.track(this.deliver(hook, e));
    }
  }

  track(p) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
    return p;
  }

  async drain() { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  // The link the receiver can GET for the full record. Uses the configured/hosted public URL, else the
  // URL the dashboard was on when the webhook was saved.
  base(hook) {
    const b = this.ctx.baseUrl(null);
    return /^http:\/\/localhost:/.test(b) && hook.baseUrl ? hook.baseUrl : b;
  }

  payload(hook, e, { test = false } = {}) {
    return {
      id: newId('dlv'),
      event: `${e.resource}.${e.type}`,
      type: e.type,
      resource: e.resource,
      resourceId: e.id,
      href: `${this.base(hook)}/v1/${e.resource}/${e.id}`,
      occurredAt: e.at,
      webhookId: hook.id,
      ...(test ? { test: true } : {}),
      ...(e.resource === 'files' ? {
        via: e.via,
        file: e.file,
        ...(e.type === 'downloaded' ? { status: e.status, range: e.range ?? null, bytes: e.bytes } : {}),
      } : {}),
      ...(hook.includeData && e.data && e.type !== 'deleted' ? { data: this.ctx.dates.formatDoc(e.data) } : {}),
    };
  }

  async deliver(hook, e, opts = {}) {
    const body = opts.payload || this.payload(hook, e, opts);
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': `api-test-tool-webhooks/${pkg.version}`,
      ...hook.headers,
      'X-Webhook-Id': hook.id,
      'X-Webhook-Event': body.event,
      'X-Webhook-Delivery': body.id,
      'X-Webhook-Timestamp': timestamp,
      ...(hook.secret ? { 'X-Webhook-Signature': sign(hook.secret, timestamp, raw) } : {}),
    };
    const started = Date.now();
    const rec = {
      id: body.id, webhookId: hook.id, webhookName: hook.name, event: body.event, resource: body.resource, resourceId: body.resourceId,
      url: hook.url, at: new Date(started).toISOString(), test: !!body.test, redeliveryOf: opts.redeliveryOf || null,
      request: { headers: { ...headers }, body },
    };
    // Custom header values may be credentials: keep only their names in the log.
    for (const k of Object.keys(hook.headers)) rec.request.headers[k] = '(set)';
    try {
      const res = await fetch(hook.url, { method: 'POST', headers, body: raw, redirect: 'manual', signal: AbortSignal.timeout(this.ctx.settings.get('webhookTimeoutMs')) });
      const text = await res.text().catch(() => '');
      rec.status = res.status;
      rec.ok = res.status >= 200 && res.status < 300;
      rec.response = { headers: Object.fromEntries(res.headers.entries()), body: text.length > MAX_BODY_LOG ? `${text.slice(0, MAX_BODY_LOG)}…(truncated)` : text };
    } catch (err) {
      rec.status = null;
      rec.ok = false;
      rec.error = err.name === 'TimeoutError' ? `No response within ${this.ctx.settings.get('webhookTimeoutMs')} ms` : (err.cause?.message || err.message);
    }
    rec.durationMs = Date.now() - started;
    await this.record(hook, rec);
    return rec;
  }

  async record(hook, rec) {
    try {
      await this.ctx.repo.put(DELIVERIES, rec.id, rec); // trim() keeps the most recently inserted
      await this.ctx.repo.trim(DELIVERIES, this.ctx.settings.get('webhookDeliveryRetention'));
      const current = this.hooks.get(hook.id);
      if (current) {
        current.lastDelivery = { at: rec.at, status: rec.status, ok: rec.ok, error: rec.error || null, durationMs: rec.durationMs, event: rec.event };
        await this.ctx.repo.put(COLL, current.id, current);
      }
    } catch (e) {
      this.ctx.log?.('error', 'webhook delivery log failed:', e.message);
    }
  }

  async deliveries({ webhookId, limit = 50 } = {}) {
    const all = (await this.ctx.repo.list(DELIVERIES)).filter((d) => !webhookId || d.webhookId === webhookId);
    all.sort((a, b) => b.at.localeCompare(a.at));
    return all.slice(0, Math.max(1, Math.min(500, limit)));
  }

  async delivery(id) {
    const d = await this.ctx.repo.get(DELIVERIES, id);
    if (!d) throw new HttpError(404, `Delivery ${id} not found`, { code: 'not-found' });
    return d;
  }

  async clearDeliveries() { await this.ctx.repo.clear(DELIVERIES); }

  // A test delivery: a real-looking event for the first record of the webhook's first resource.
  async test(id, { type } = {}) {
    const hook = this.get(id);
    const evType = type || hook.events[0];
    if (!EVENTS.includes(evType)) throw bad(`type must be one of ${EVENTS.join(', ')}`, 'type');
    const at = new Date().toISOString();
    const fileEvent = evType === 'uploaded' || evType === 'downloaded' || (evType === 'deleted' && !hasData(hook.resources));
    if (fileEvent) {
      if (!hook.resources.includes('files')) throw bad(`${evType} is a file event; this webhook does not watch files`, 'type');
      const f = (await this.ctx.files.list())[0] || { id: 'f_example', name: 'example.txt', contentType: 'text/plain', size: 0 };
      const file = { id: f.id, name: f.name, contentType: f.contentType, size: f.size, sha256: f.sha256 || null, source: f.source, createdAt: f.createdAt, updatedAt: f.updatedAt };
      const extra = evType === 'downloaded' ? { status: 200, range: null, bytes: f.size } : {};
      return this.track(this.deliver(hook, { type: evType, resource: 'files', id: f.id, at, via: 'test', file, ...extra }, { test: true }));
    }
    if (!hasData(hook.resources)) throw bad(`${evType} is a data event; this webhook only watches files`, 'type');
    const resource = hook.resources[0] === '*' ? 'employees' : hook.resources[0];
    const doc = (await this.ctx.resources.all(resource))[0] || { id: 1 };
    return this.track(this.deliver(hook, { type: evType, resource, id: doc.id, at, data: doc }, { test: true }));
  }

  // Send a logged delivery again (same payload and delivery id, fresh timestamp and signature).
  async redeliver(deliveryId) {
    const d = await this.delivery(deliveryId);
    const hook = this.get(d.webhookId);
    return this.track(this.deliver(hook, null, { payload: { ...d.request.body, id: newId('dlv') }, redeliveryOf: d.id }));
  }
}

module.exports = { WebhookService, normalize, sign, EVENTS, RESOURCES, publicView };
