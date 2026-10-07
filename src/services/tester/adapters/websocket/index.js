'use strict';
// WebSocket contract adapter for the tester. Two kinds of spec:
//   asyncapi   an AsyncAPI 2.x / 3.0 document: channels, message schemas, examples, correlation ids
//   websocket  no contract: a URL plus a scripted scenario
// "Try it" connects, sends one message, listens for replies, closes, and checks the upgrade,
// subprotocol, every received message (against the channel's server→client schemas), the correlated
// reply and the close handshake. "Run all" runs a scenario (automatic from the AsyncAPI document, or
// hand-written) plus optional negative tests (no credentials, malformed message, oversized message,
// invalid UTF-8).
const { connect, encodeFrame, OP, CLOSE_NAMES } = require('../../../../util/websocket');
const { HttpError } = require('../../../../util/problem');
const { applyAuth } = require('../../auth');
const { SpecValidator } = require('../../validate');
const { sample } = require('../../sample');
const { get, resolve } = require('../../refs');
const { summarize } = require('../../runner');
const { loadAsyncApi, lintAsyncApi } = require('./asyncapi');

const DEFAULT_WAIT = 1500;
const MAX_TRANSCRIPT = 200;

const closeText = (c) => `${c.code}${CLOSE_NAMES[c.code] ? ` (${CLOSE_NAMES[c.code]})` : ''}${c.reason ? ` "${c.reason}"` : ''}`;

function render(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, k) => {
    if (k === 'uuid') return require('node:crypto').randomUUID();
    if (k === 'now') return new Date().toISOString();
    if (k === 'timestamp') return String(Math.floor(Date.now() / 1000));
    return vars && vars[k] !== undefined ? String(vars[k]) : m;
  });
}
function deepRender(v, vars) {
  if (typeof v === 'string') return render(v, vars);
  if (Array.isArray(v)) return v.map((x) => deepRender(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRender(x, vars)]));
  return v;
}

function pointerGet(obj, ptr) {
  if (!ptr) return obj;
  let cur = obj;
  for (const raw of ptr.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

const CORRELATION_KEYS = ['id', 'requestId', 'correlationId', 'reqId', 'rid', 'messageId'];
function correlationValue(payload, ptr) {
  if (!payload || typeof payload !== 'object') return { ptr: null, value: undefined };
  if (ptr !== null && ptr !== undefined) return { ptr, value: pointerGet(payload, ptr) };
  const k = CORRELATION_KEYS.find((x) => payload[x] !== undefined && payload[x] !== null && typeof payload[x] !== 'object');
  return k ? { ptr: `/${k}`, value: payload[k] } : { ptr: null, value: undefined };
}

function channelUrl(base, address) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!address) return b;
  return `${b}${address.startsWith('/') ? '' : '/'}${address}`;
}

function parseProtocols(v) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- one connection, recorded
class Session {
  constructor() { this.frames = []; this.messages = []; this.closed = null; this.started = Date.now(); this.waiters = []; }

  at() { return Date.now() - this.started; }

  log(dir, type, data) {
    if (this.frames.length < MAX_TRANSCRIPT) this.frames.push({ dir, type, at: this.at(), data });
  }

  attach(conn) {
    this.conn = conn;
    conn.on('message', (m) => {
      const text = m.binary ? null : m.data;
      const entry = { at: this.at(), binary: m.binary, text, size: m.binary ? m.data.length : Buffer.byteLength(m.data) };
      try { if (text !== null) entry.json = JSON.parse(text); } catch { /* not JSON */ }
      this.messages.push(entry);
      this.log('in', m.binary ? 'binary' : 'text', m.binary ? `[${m.data.length} bytes] ${m.data.subarray(0, 32).toString('hex')}` : text.slice(0, 4000));
      this.notify();
    });
    conn.on('pong', (p) => { this.log('in', 'pong', p.toString('utf8')); this.notify(); });
    conn.on('ping', (p) => this.log('in', 'ping', p.toString('utf8')));
    conn.on('close', (c) => { this.closed = { ...c, at: this.at() }; this.log(c.by === 'local' ? 'out' : 'in', 'close', closeText(c)); this.notify(); });
    conn.on('error', (e) => this.log('in', 'error', e.message));
  }

  notify() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }

  /** Wait until pred() is true, the connection closes, or the timeout passes. */
  until(pred, ms) {
    return new Promise((resolveP) => {
      let expired = false;
      const check = () => {
        if (pred() || this.closed || expired) { clearTimeout(t); resolveP(pred()); return; }
        this.waiters.push(check);
      };
      const t = setTimeout(() => { expired = true; this.notify(); }, Math.max(0, ms));
      check();
    });
  }

  send(data, { binary = false } = {}) {
    const payload = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
    this.log('out', binary ? 'binary' : 'text', binary ? `[${Buffer.from(payload).length} bytes]` : String(payload).slice(0, 4000));
    this.conn.send(payload, { binary });
  }

  async close(code = 1000) {
    if (!this.closed && this.conn) {
      this.conn.close(code, 'test done');
      await this.until(() => !!this.closed, 2000);
      if (!this.closed) this.conn.terminate();
    }
  }

  transcript() {
    return this.frames.map((f) => `${f.dir === 'out' ? '→' : '←'} ${String(f.at).padStart(5)} ms  ${f.type === 'text' ? '' : `[${f.type}] `}${f.data}`).join('\n');
  }
}

// ---------------------------------------------------------------- adapter
class WebSocketAdapter {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind; // 'asyncapi' | 'websocket'
    this.label = kind === 'asyncapi' ? 'AsyncAPI' : 'WebSocket';
    this.validators = new Map();
  }

  detect(text) {
    try {
      const d = require('js-yaml').load(String(text || ''), { json: true });
      return !!(d && typeof d === 'object' && d.asyncapi);
    } catch { return false; }
  }

  async load({ content, url }) {
    if (this.kind === 'websocket') {
      const u = String(url || content || '').trim();
      if (!/^wss?:\/\//i.test(u)) throw new HttpError(422, 'A WebSocket scenario needs a ws:// or wss:// URL');
      return {
        doc: { kind: 'websocket', url: u }, title: `WebSocket ${new URL(u).host}`, apiVersion: '', version: 'WebSocket', originalVersion: 'websocket',
        converted: false, notes: ['No contract: messages are not schema-checked. Edit the scenario on the Run all tab.'], structural: [],
        defaultTarget: { baseUrl: u, subprotocols: [] }, options: {},
      };
    }
    const { doc, model, title, apiVersion } = await loadAsyncApi({ content });
    const ws = model.servers.find((s) => /^wss?:/.test(s.url));
    return {
      doc: { ...doc, 'x-tester-model': model }, title, apiVersion, version: `AsyncAPI ${model.asyncapiVersion}`, originalVersion: model.asyncapiVersion,
      converted: false,
      notes: [`${model.channels.length} channel${model.channels.length === 1 ? '' : 's'} · servers: ${model.servers.map((s) => `${s.name} (${s.url})`).join(', ') || 'none'}`],
      structural: [], defaultTarget: { baseUrl: ws ? ws.url : '', subprotocols: [] }, options: {},
    };
  }

  model(spec) { return spec.doc['x-tester-model'] || { channels: [], servers: [] }; }

  invalidate(specId) { for (const k of [...this.validators.keys()]) if (k.startsWith(`${specId}|`)) this.validators.delete(k); }

  validator(spec) {
    const key = `${spec.id}|${spec.updatedAt}`;
    if (!this.validators.has(key)) {
      const { 'x-tester-model': _m, ...doc } = spec.doc; // eslint-disable-line no-unused-vars
      this.validators.set(key, new SpecValidator(doc, { version: '3.1' }));
    }
    return this.validators.get(key);
  }

  lint(spec) {
    if (this.kind === 'websocket') return { issues: [], counts: { error: 0, warning: 0, info: 0 } };
    return lintAsyncApi({ ...spec, model: this.model(spec) });
  }

  channels(spec) {
    if (this.kind === 'websocket') return [{ id: 'session', address: '', description: spec.doc.url, toServer: [], fromServer: [] }];
    return this.model(spec).channels;
  }

  operationCount(spec) { return this.channels(spec).length; }

  operations(spec) {
    return this.channels(spec).map((c) => ({
      id: c.id, method: 'ws', path: c.address || '', operationId: c.id, summary: c.description, tags: [], deprecated: false, hasBody: true, secured: false, responses: [],
      ws: { toServer: c.toServer.map((m) => m.name), fromServer: c.fromServer.map((m) => m.name) },
    }));
  }

  channel(spec, opId) {
    const c = this.channels(spec).find((x) => x.id === opId);
    if (!c) throw new HttpError(404, `Channel ${opId} not found`);
    return c;
  }

  samplePayload(spec, msg) {
    if (msg.examples.length) return JSON.parse(JSON.stringify(msg.examples[0].payload));
    if (!msg.payloadPointer) return '';
    const schema = get(spec.doc, msg.payloadPointer);
    return sample(spec.doc, resolve(spec.doc, schema).node || {}, { mode: 'request' });
  }

  defaultRequest(spec, opId, exampleName) {
    const c = this.channel(spec, opId);
    const options = c.toServer.flatMap((m) => (m.examples.length ? m.examples.map((e) => ({ name: `${m.name}: ${e.name}`, message: m, payload: e.payload })) : [{ name: m.name, message: m, payload: null }]));
    const chosen = options.find((o) => o.name === exampleName) || options[0];
    let body = '';
    let contentType = 'text/plain';
    if (chosen) {
      body = chosen.payload !== null ? JSON.parse(JSON.stringify(chosen.payload)) : this.samplePayload(spec, chosen.message);
      contentType = typeof body === 'string' && !/json/i.test(chosen.message.contentType) ? 'text/plain' : 'application/json';
      if (contentType === 'text/plain' && typeof body !== 'string') body = JSON.stringify(body);
    } else if (this.kind === 'websocket') {
      body = { type: 'ping' };
      contentType = 'application/json';
    }
    return {
      opId: c.id, kind: 'ws', address: c.address,
      params: [{ in: 'option', name: 'waitMs', value: String(DEFAULT_WAIT), required: false, enabled: true, description: 'How long to listen for messages after sending', schema: {} }],
      contentType, body,
      examples: options.map((o) => ({ name: o.name, summary: '', value: o.payload })), exampleName: chosen?.name || null,
      multipart: null, binary: null,
    };
  }

  // ---- connection with the target's URL, auth, headers and subprotocols
  async open(spec, target, address, { noAuth = false, vars = {}, protocols } = {}) {
    const base = target.baseUrl || (this.kind === 'websocket' ? spec.doc.url : '');
    let url = channelUrl(render(base, vars), render(address || '', vars));
    if (!/^wss?:\/\//i.test(url)) return { error: `No usable WebSocket URL ("${url || 'none'}"). Set the server URL on the Target tab.` };
    const headers = Object.fromEntries(Object.entries(target.headers || {}).map(([k, v]) => [k, render(String(v), vars)]));
    const query = {};
    let tokenExchange = null;
    if (!noAuth && target.auth && target.auth.type !== 'none') {
      try { tokenExchange = await applyAuth(target.auth, { headers, query }); } catch (e) { return { error: e.message, tokenExchange: e.exchange || null }; }
    }
    if (Object.keys(query).length) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      url = u.toString();
    }
    const subprotocols = protocols ?? parseProtocols(target.subprotocols);
    const session = new Session();
    let res;
    try {
      res = await connect(url, { headers, protocols: subprotocols, timeoutMs: target.timeoutMs || 15000 });
    } catch (e) {
      return { error: `Connection failed: ${e.message}`, request: { method: 'GET', url, headers }, tokenExchange };
    }
    const request = { method: 'GET', url, headers: { ...headers, ...(subprotocols.length ? { 'Sec-WebSocket-Protocol': subprotocols.join(', ') } : {}) } };
    if (res.conn) session.attach(res.conn);
    return { res, session, request, subprotocols, tokenExchange };
  }

  upgradeChecks(o) {
    const checks = [];
    if (o.res.status === 101 && o.res.conn) checks.push({ name: 'upgrade', status: 'pass', message: `Upgraded (101) in ${o.res.durationMs} ms` });
    else checks.push({ name: 'upgrade', status: 'fail', message: `Upgrade rejected: HTTP ${o.res.status}${o.res.error ? ` — ${o.res.error}` : ''}${o.res.body ? ` — ${o.res.body.slice(0, 200)}` : ''}` });
    if (o.res.conn) {
      const got = o.res.protocol;
      if (o.subprotocols.length) {
        if (!got) checks.push({ name: 'subprotocol', status: 'warn', message: `Requested ${o.subprotocols.join(', ')} but the server selected none` });
        else checks.push({ name: 'subprotocol', status: o.subprotocols.includes(got) ? 'pass' : 'fail', message: o.subprotocols.includes(got) ? `Server selected "${got}"` : `Server selected "${got}", which was not offered` });
      } else if (got) checks.push({ name: 'subprotocol', status: 'fail', message: `Server selected subprotocol "${got}" although none was offered` });
    }
    return checks;
  }

  /** Validate one received message against the channel's server→client messages. */
  messageCheck(spec, channel, m, i) {
    const name = `message[${i + 1}]`;
    if (this.kind === 'websocket' || !channel.fromServer.length) return null;
    const candidates = channel.fromServer.filter((x) => x.payloadPointer);
    if (!candidates.length) return null;
    if (m.binary) return { name, status: 'warn', message: 'Binary message; payload schemas are not checked for binary data' };
    const value = m.json !== undefined ? m.json : m.text;
    let best = null;
    for (const c of candidates) {
      if (m.json === undefined && /json/i.test(c.contentType)) { if (!best) best = { c, errs: [{ pointer: '', message: 'Message is not valid JSON' }] }; continue; }
      const errs = this.validator(spec).validate(c.payloadPointer, value);
      if (!errs.length) return { name, status: 'pass', message: `Matches ${c.name}` };
      if (!best || errs.length < best.errs.length) best = { c, errs };
    }
    return { name, status: 'fail', message: `Matches none of ${candidates.map((c) => c.name).join(', ')} (closest: ${best.c.name})`, errors: best.errs.slice(0, 30) };
  }

  result(o, checks, extra = {}) {
    const s = o.session;
    const outcome = summarize(checks);
    return {
      ...extra,
      request: o.request ? { ...o.request, body: s ? s.frames.filter((f) => f.dir === 'out').map((f) => f.data).join('\n') : null } : undefined,
      response: o.res ? {
        status: o.res.status, statusText: o.res.status === 101 ? 'Switching Protocols' : '', headers: o.res.headers || {},
        size: s ? s.messages.reduce((n, m) => n + m.size, 0) : (o.res.body || '').length,
        durationMs: s ? s.at() : o.res.durationMs,
        body: s && o.res.conn ? s.transcript() : o.res.body || '',
      } : undefined,
      frames: s ? s.frames : [],
      error: o.error,
      tokenExchange: o.tokenExchange || null,
      checks, outcome, pass: outcome !== 'fail',
    };
  }

  // ---- try it: connect, send, listen, close
  async send(spec, { opId, request, target }) {
    const c = this.channel(spec, opId);
    const req = request || this.defaultRequest(spec, opId);
    const waitMs = Math.min(60000, Number((req.params || []).find((p) => p.name === 'waitMs')?.value) || DEFAULT_WAIT);
    const o = await this.open(spec, target, req.address ?? c.address);
    if (o.error) return this.result(o, [{ name: 'connect', status: 'fail', message: o.error }], { opId });
    const checks = this.upgradeChecks(o);
    if (!o.res.conn) return this.result(o, checks, { opId });
    const s = o.session;
    let sentPayload = null;
    if (req.body !== '' && req.body !== null && req.body !== undefined) {
      const payload = deepRender(req.body, {});
      sentPayload = payload;
      s.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
    const corr = correlationValue(sentPayload, (c.toServer.find((m) => m.correlation !== null) || {}).correlation ?? null);
    if (corr.value !== undefined) await s.until(() => s.messages.some((m) => m.json && pointerGet(m.json, corr.ptr) === corr.value), waitMs);
    else await s.until(() => false, waitMs);
    this.messageChecks(spec, c, s, checks, sentPayload, corr);
    await this.closeCheck(s, checks);
    return this.result(o, checks, { opId });
  }

  messageChecks(spec, c, s, checks, sentPayload, corr) {
    s.messages.forEach((m, i) => { const ch = this.messageCheck(spec, c, m, i); if (ch) checks.push(ch); });
    const expectsReply = sentPayload !== null && (this.kind === 'websocket' || c.fromServer.length > 0);
    if (expectsReply) {
      checks.push(s.messages.length
        ? { name: 'reply', status: 'pass', message: `${s.messages.length} message${s.messages.length > 1 ? 's' : ''} received` }
        : { name: 'reply', status: 'fail', message: 'No message received after sending' });
    }
    if (corr && corr.value !== undefined && s.messages.length) {
      const hit = s.messages.find((m) => m.json && pointerGet(m.json, corr.ptr) === corr.value);
      checks.push(hit
        ? { name: 'correlation', status: 'pass', message: `Reply carries ${corr.ptr.slice(1)} = ${JSON.stringify(corr.value)} (${hit.at} ms)` }
        : { name: 'correlation', status: 'fail', message: `No reply with ${corr.ptr.slice(1)} = ${JSON.stringify(corr.value)}` });
    }
  }

  async closeCheck(s, checks) {
    if (s.closed) {
      const ok = s.closed.code === 1000;
      checks.push({ name: 'connection', status: ok ? 'warn' : 'fail', message: `The server closed the connection: ${closeText(s.closed)}` });
      return;
    }
    await s.close(1000);
    if (s.closed && s.closed.clean) checks.push({ name: 'close', status: 'pass', message: `Clean close handshake (${closeText(s.closed)})` });
    else checks.push({ name: 'close', status: 'warn', message: `No clean close handshake${s.closed ? `: ${closeText(s.closed)}` : ''}` });
  }

  // ---- run all
  autoScenario(spec) {
    if (this.kind === 'websocket') {
      return [{ connect: {} }, { send: { type: 'ping' } }, { expect: { timeoutMs: 5000 } }, { close: 1000 }];
    }
    const steps = [];
    for (const c of this.model(spec).channels) {
      if (c.toServer.length) {
        for (const m of c.toServer) {
          steps.push({ connect: { channel: c.id }, label: `${c.id}: send ${m.name}` });
          steps.push({ send: { message: m.name } });
          if (c.fromServer.length) steps.push({ expect: { timeoutMs: 5000, correlate: true } });
          steps.push({ close: 1000 });
        }
      } else if (c.fromServer.length) {
        steps.push({ connect: { channel: c.id }, label: `${c.id}: listen` });
        steps.push({ listen: 2000 });
        steps.push({ close: 1000 });
      }
    }
    return steps;
  }

  async run(spec, { target, negative = false, variables = {} }) {
    const scenario = Array.isArray(spec.scenario) && spec.scenario.length ? spec.scenario : this.autoScenario(spec);
    const vars = { ...variables };
    const steps = [];
    const push = (step, checks, o = {}) => steps.push(this.result(o, checks, step));
    let cur = null; // { o, channel, lastSent, corr }

    const finishCurrent = async () => {
      if (cur && cur.o.session && !cur.o.session.closed) await cur.o.session.close(1000);
      cur = null;
    };

    for (let i = 0; i < scenario.length; i++) {
      const st = scenario[i] || {};
      const kind = Object.keys(st).find((k) => ['connect', 'send', 'expect', 'listen', 'wait', 'ping', 'close', 'expectClose'].includes(k));
      const label = st.label || `${kind || 'step'} #${i + 1}`;
      const base = { kind: 'positive', opId: label, phase: i };
      if (!kind) { push(base, [{ name: 'scenario', status: 'fail', message: `Unknown step ${JSON.stringify(st).slice(0, 120)}` }]); continue; }
      try {
        if (kind === 'connect') {
          await finishCurrent();
          const cfg = st.connect || {};
          const channel = this.kind === 'websocket' ? this.channels(spec)[0] : (cfg.channel ? this.channel(spec, cfg.channel) : this.channels(spec)[0]);
          const o = await this.open(spec, target, cfg.address ?? channel?.address, { vars, protocols: cfg.protocols ? parseProtocols(cfg.protocols) : undefined });
          if (o.error) { push(base, [{ name: 'connect', status: 'fail', message: o.error }], o); cur = null; continue; }
          const checks = this.upgradeChecks(o);
          push(base, checks, o);
          cur = o.res.conn ? { o, channel, lastSent: null, corr: null, seen: 0 } : null;
          continue;
        }
        if (!cur) { push(base, [{ name: 'scenario', status: 'fail', message: `"${kind}" needs an open connection (add a connect step first, or the connection failed)` }]); continue; }
        const s = cur.o.session;
        if (kind === 'send') {
          let payload = st.send;
          let msgDef = null;
          if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.message && Object.keys(payload).length === 1 && this.kind === 'asyncapi') {
            msgDef = cur.channel.toServer.find((m) => m.name === payload.message);
            if (!msgDef) { push(base, [{ name: 'send', status: 'fail', message: `Channel ${cur.channel.id} has no client→server message "${payload.message}"` }]); continue; }
            payload = this.samplePayload(spec, msgDef);
          }
          payload = deepRender(payload, vars);
          const before = s.frames.length;
          s.send(typeof payload === 'string' ? payload : JSON.stringify(payload), { binary: !!st.binary });
          cur.lastSent = payload;
          cur.corr = correlationValue(payload, msgDef?.correlation ?? (cur.channel?.toServer.find((m) => m.correlation !== null) || {}).correlation ?? null);
          push({ ...base, kind: 'positive' }, [{ name: 'send', status: 'pass', message: `Sent ${typeof payload === 'string' ? `${payload.length} characters` : 'a JSON message'}` }], { request: { ...cur.o.request }, session: { frames: s.frames.slice(before), messages: [], at: () => 0, transcript: () => '' } });
          continue;
        }
        if (kind === 'expect') {
          const cfg = st.expect || {};
          const timeoutMs = cfg.timeoutMs || 5000;
          const from = cur.seen;
          const corr = cfg.correlate !== false && cur.corr && cur.corr.value !== undefined ? cur.corr : null;
          const matches = (m) => {
            if (corr && !(m.json && pointerGet(m.json, corr.ptr) === corr.value)) return false;
            if (cfg.contains && !(m.text || '').includes(cfg.contains)) return false;
            if (cfg.match && typeof cfg.match === 'object') {
              for (const [ptr, want] of Object.entries(cfg.match)) if (!m.json || JSON.stringify(pointerGet(m.json, ptr.startsWith('/') ? ptr : `/${ptr}`)) !== JSON.stringify(deepRender(want, vars))) return false;
            }
            return true;
          };
          await s.until(() => s.messages.slice(from).some(matches), timeoutMs);
          const got = s.messages.slice(from);
          const hit = got.find(matches);
          const checks = [];
          got.forEach((m, j) => { const ch = this.messageCheck(spec, cur.channel, m, from + j); if (ch) checks.push(ch); });
          checks.push(hit
            ? { name: 'expect', status: 'pass', message: `Matching message after ${hit.at} ms${corr ? ` (${corr.ptr.slice(1)} = ${JSON.stringify(corr.value)})` : ''}` }
            : { name: 'expect', status: 'fail', message: `No matching message within ${timeoutMs} ms${corr ? ` with ${corr.ptr.slice(1)} = ${JSON.stringify(corr.value)}` : ''}${got.length ? ` (${got.length} other message${got.length > 1 ? 's' : ''})` : ''}${s.closed ? `; connection closed ${closeText(s.closed)}` : ''}` });
          if (hit && hit.json && cfg.capture) for (const [name, ptr] of Object.entries(cfg.capture)) { const v = pointerGet(hit.json, ptr.startsWith('/') ? ptr : `/${ptr}`); if (v !== undefined) vars[name] = typeof v === 'object' ? JSON.stringify(v) : String(v); }
          if (hit && hit.json && typeof hit.json === 'object') for (const [k, v] of Object.entries(hit.json)) if (/(^id$|Id$)/.test(k) && v !== null && typeof v !== 'object' && vars[k] === undefined) vars[k] = String(v);
          cur.seen = s.messages.length;
          push(base, checks, { ...cur.o, session: { frames: s.frames.filter((f) => f.dir === 'in').slice(-20), messages: got, at: () => s.at(), transcript: () => got.map((m) => `← ${String(m.at).padStart(5)} ms  ${m.text ?? `[binary ${m.size} bytes]`}`).join('\n') } });
          continue;
        }
        if (kind === 'listen') {
          const ms = Number(st.listen) || 2000;
          const from = cur.seen;
          await s.until(() => false, ms);
          const got = s.messages.slice(from);
          const checks = [];
          got.forEach((m, j) => { const ch = this.messageCheck(spec, cur.channel, m, from + j); if (ch) checks.push(ch); });
          if (!got.length) checks.push({ name: 'listen', status: 'skip', message: `No messages in ${ms} ms (nothing to validate)` });
          else checks.push({ name: 'listen', status: 'pass', message: `${got.length} message${got.length > 1 ? 's' : ''} in ${ms} ms` });
          if (s.closed) checks.push({ name: 'connection', status: s.closed.code === 1000 ? 'warn' : 'fail', message: `The server closed the connection: ${closeText(s.closed)}` });
          cur.seen = s.messages.length;
          push(base, checks, { ...cur.o, session: { frames: [], messages: got, at: () => s.at(), transcript: () => got.map((m) => `← ${String(m.at).padStart(5)} ms  ${m.text ?? `[binary ${m.size} bytes]`}`).join('\n') } });
          continue;
        }
        if (kind === 'wait') { await new Promise((r) => setTimeout(r, Math.min(60000, Number(st.wait) || 0))); continue; }
        if (kind === 'ping') {
          const before = s.frames.filter((f) => f.type === 'pong').length;
          cur.o.res.conn.ping('tester');
          await s.until(() => s.frames.filter((f) => f.type === 'pong').length > before, Number(st.ping?.timeoutMs) || 3000);
          const ok = s.frames.filter((f) => f.type === 'pong').length > before;
          push(base, [{ name: 'pong', status: ok ? 'pass' : 'fail', message: ok ? 'Pong received' : 'No pong within the timeout' }]);
          continue;
        }
        if (kind === 'close') {
          const code = Number(typeof st.close === 'object' ? st.close.code : st.close) || 1000;
          const checks = [];
          if (s.closed) checks.push({ name: 'connection', status: s.closed.code === 1000 ? 'warn' : 'fail', message: `Already closed by the server: ${closeText(s.closed)}` });
          else {
            await s.close(code);
            checks.push(s.closed?.clean ? { name: 'close', status: 'pass', message: `Clean close (${closeText(s.closed)})` } : { name: 'close', status: 'warn', message: 'No clean close handshake' });
          }
          push(base, checks);
          cur = null;
          continue;
        }
        if (kind === 'expectClose') {
          const want = Number(typeof st.expectClose === 'object' ? st.expectClose.code : st.expectClose) || null;
          await s.until(() => !!s.closed, Number(st.expectClose?.timeoutMs) || 5000);
          const checks = [s.closed
            ? { name: 'expect-close', status: !want || s.closed.code === want ? 'pass' : 'fail', message: `Closed with ${closeText(s.closed)}${want && s.closed.code !== want ? `, expected ${want}` : ''}` }
            : { name: 'expect-close', status: 'fail', message: 'The server did not close the connection' }];
          push(base, checks);
          if (s.closed) cur = null;
          continue;
        }
      } catch (e) {
        push(base, [{ name: 'step', status: 'fail', message: e.message }]);
      }
    }
    await finishCurrent();

    if (negative) await this.negatives(spec, target, steps, vars);

    const summary = {
      total: steps.length,
      passed: steps.filter((s) => s.outcome === 'pass').length,
      warned: steps.filter((s) => s.outcome === 'warn').length,
      failed: steps.filter((s) => s.outcome === 'fail').length,
    };
    return { steps, summary, variables: vars, options: {} };
  }

  async negatives(spec, target, steps, vars) {
    const all = this.channels(spec);
    const channel = this.kind === 'websocket' ? all[0]
      : all.find((c) => c.toServer.some((m) => /json/i.test(m.contentType))) || all.find((c) => c.toServer.length) || all[0];
    if (!channel) return;
    const address = channel.address;
    const neg = (test, checks, o) => steps.push(this.result(o, checks, { kind: 'negative', test, opId: channel.id }));
    const settle = (s, ms) => s.until(() => !!s.closed, ms);

    if (target.auth && target.auth.type !== 'none') {
      const o = await this.open(spec, target, address, { noAuth: true, vars });
      if (o.error) neg('no-auth', [{ name: 'connect', status: 'fail', message: o.error }], o);
      else if (!o.res.conn) {
        const st = o.res.status;
        neg('no-auth', [{ name: 'expect-reject', status: st === 401 ? 'pass' : st === 403 ? 'warn' : 'fail', message: st === 401 ? 'Upgrade without credentials rejected with 401' : st === 403 ? 'Upgrade without credentials rejected with 403 (401 is expected for missing credentials)' : `Upgrade without credentials failed with HTTP ${st}` }], o);
      } else {
        await settle(o.session, 2000);
        const s = o.session;
        const checks = [s.closed && s.closed.code === 1008
          ? { name: 'expect-reject', status: 'warn', message: 'Accepted the upgrade, then closed with 1008; rejecting the upgrade with 401 is better' }
          : { name: 'expect-reject', status: 'fail', message: s.closed ? `Accepted without credentials, then closed with ${closeText(s.closed)}` : 'Accepted the connection without credentials' }];
        await s.close();
        neg('no-auth', checks, o);
      }
    }

    // Malformed message
    {
      const o = await this.open(spec, target, address, { vars });
      if (o.res?.conn) {
        const s = o.session;
        s.send('{"malformed": ');
        await s.until(() => s.messages.length > 0, 2000);
        const checks = [];
        if (s.closed) checks.push({ name: 'expect-error', status: [1003, 1007, 1008].includes(s.closed.code) ? 'pass' : [1006, 1011].includes(s.closed.code) ? 'fail' : 'warn', message: `Closed with ${closeText(s.closed)} after a malformed message` });
        else if (s.messages.length) checks.push({ name: 'expect-error', status: 'pass', message: `Replied to the malformed message: ${(s.messages[0].text || '').slice(0, 160)}` });
        else checks.push({ name: 'expect-error', status: 'warn', message: 'Malformed message was ignored: no error reply and no close within 2 s' });
        await s.close();
        neg('malformed-message', checks, o);
      } else neg('malformed-message', [{ name: 'connect', status: 'fail', message: o.error || `Upgrade failed with HTTP ${o.res?.status}` }], o);
    }

    // Oversized message
    {
      const kb = Number(target.oversizeKb) || 2048;
      const o = await this.open(spec, target, address, { vars });
      if (o.res?.conn) {
        const s = o.session;
        s.send('x'.repeat(kb * 1024));
        await settle(s, 3000);
        const checks = [s.closed
          ? { name: 'expect-1009', status: s.closed.code === 1009 ? 'pass' : [1006, 1011].includes(s.closed.code) ? 'fail' : 'warn', message: `Closed with ${closeText(s.closed)} after a ${kb} KB message${s.closed.code === 1009 ? '' : ' (1009 is the code for "message too big")'}` }
          : { name: 'expect-1009', status: 'warn', message: `A ${kb} KB message was accepted: no size limit enforced` }];
        await s.close();
        neg('oversized-message', checks, o);
      } else neg('oversized-message', [{ name: 'connect', status: 'fail', message: o.error || `Upgrade failed with HTTP ${o.res?.status}` }], o);
    }

    // Invalid UTF-8 in a text frame
    {
      const o = await this.open(spec, target, address, { vars });
      if (o.res?.conn) {
        const s = o.session;
        o.res.conn.sendRaw(encodeFrame(OP.TEXT, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { mask: true }));
        s.log('out', 'text', '[4 bytes of invalid UTF-8]');
        await settle(s, 2000);
        const checks = [s.closed
          ? { name: 'expect-1007', status: s.closed.code === 1007 ? 'pass' : [1006, 1011].includes(s.closed.code) ? 'fail' : 'warn', message: `Closed with ${closeText(s.closed)}${s.closed.code === 1007 ? '' : ' (RFC 6455 requires 1007 for invalid UTF-8)'}` }
          : { name: 'expect-1007', status: 'warn', message: 'Invalid UTF-8 in a text frame was accepted (RFC 6455 requires closing with 1007)' }];
        await s.close();
        neg('invalid-utf8', checks, o);
      } else neg('invalid-utf8', [{ name: 'connect', status: 'fail', message: o.error || `Upgrade failed with HTTP ${o.res?.status}` }], o);
    }
  }

  profiles() {
    return [
      { type: 'none', label: 'None' },
      { type: 'bearer', label: 'Bearer token (Authorization header)', token: '' },
      { type: 'apikey', label: 'API key / token in the query string', in: 'query', name: 'access_token', value: '' },
      { type: 'apikey', label: 'API key header', in: 'header', name: 'X-API-Key', value: '' },
      { type: 'basic', label: 'HTTP Basic', username: '', password: '' },
      { type: 'oauth2cc', label: 'OAuth2 client credentials (Bearer header)', tokenUrl: '', clientId: '', clientSecret: '', scopes: '', clientAuth: 'basic' },
    ];
  }

  async mock() { throw new HttpError(400, 'Mock from spec is available for OpenAPI specs only. To rehearse a WebSocket run, load "This tool (live AsyncAPI)" and test this server\'s /ws channels.', { code: 'mock-not-supported' }); }

  async unmock() { return 0; }

  document(spec) {
    if (this.kind === 'websocket') return { contentType: 'application/json', body: JSON.stringify({ url: spec.doc.url, scenario: spec.scenario || this.autoScenario(spec) }, null, 2) };
    const { 'x-tester-model': _m, ...doc } = spec.doc; // eslint-disable-line no-unused-vars
    return { contentType: 'application/json', body: JSON.stringify(doc) };
  }
}

module.exports = { WebSocketAdapter, Session, correlationValue, channelUrl };
