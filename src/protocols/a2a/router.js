'use strict';
// /a2a — a mock A2A agent (Agent2Agent protocol 1.0, plus 0.3 for older clients) that answers questions about
// the shared mock data (agent.js) as tasks with streamed artifacts (tasks.js).
//
//   GET  /.well-known/agent-card.json, /a2a/.well-known/agent-card.json   1.0 Agent Card (open)
//   GET  /a2a/v0.3/.well-known/agent-card.json                            0.3 Agent Card (open)
//   POST /a2a          JSON-RPC: A2A-Version: 1.0 -> SendMessage, SendStreamingMessage, GetTask, ListTasks,
//                      CancelTask, SubscribeToTask, *TaskPushNotificationConfig*, GetExtendedAgentCard;
//                      no A2A-Version (= 0.3, as the spec requires) -> message/send, message/stream, tasks/get, …
//   POST /a2a/v0.3     JSON-RPC 0.3 whatever the header says (for 0.3 clients given the 0.3 card)
//   /a2a/rest/…        HTTP+JSON binding (1.0): POST /message:send, /message:stream, GET /tasks, /tasks/{id},
//                      POST /tasks/{id}:cancel, GET /tasks/{id}:subscribe, push-config CRUD, GET /extendedAgentCard
//
// Requests go through the shared protocol stack (AUTH_MODE, rate limit, required headers, chaos). In the oauth2
// mode a question needs scope "read" and a change needs "write". Chaos for A2A: X-Force-A2A-Error:
// fail | reject | input-required | auth-required | rpc[:code] | drop.
require('./errors');
const express = require('express');
const { sendProblem } = require('../../util/problem');
const { protocolStack } = require('../../middleware/protocol');
const { verify } = require('../../middleware/body');
const { makeEngine, A2AError } = require('./tasks');
const { card10, card03 } = require('./card');
const { rpcError, restError } = require('./errors');
const W = require('./wire');

const V1 = {
  SendMessage: 'send', SendStreamingMessage: 'stream', GetTask: 'get', ListTasks: 'list', CancelTask: 'cancel', SubscribeToTask: 'subscribe',
  CreateTaskPushNotificationConfig: 'pushCreate', GetTaskPushNotificationConfig: 'pushGet', ListTaskPushNotificationConfigs: 'pushList',
  DeleteTaskPushNotificationConfig: 'pushDelete', GetExtendedAgentCard: 'card',
};
const V03 = {
  'message/send': 'send', 'message/stream': 'stream', 'tasks/get': 'get', 'tasks/cancel': 'cancel', 'tasks/resubscribe': 'subscribe',
  'tasks/pushNotificationConfig/set': 'pushCreate', 'tasks/pushNotificationConfig/get': 'pushGet', 'tasks/pushNotificationConfig/list': 'pushList',
  'tasks/pushNotificationConfig/delete': 'pushDelete', 'agent/getAuthenticatedExtendedCard': 'card',
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (name, message, opts) => { const e = new A2AError(name, message, opts?.meta); e.violations = opts?.violations; return e; };

function versionOf(req) {
  const raw = req.get('a2a-version') ?? req.query['A2A-Version'] ?? '';
  const v = String(raw).trim();
  if (!v) return '0.3';
  const m = /^(\d+)\.(\d+)/.exec(v);
  return m ? `${Number(m[1])}.${Number(m[2])}` : v;
}

// Validates and normalizes a message to the 1.0 shape.
function readMessage(m, version, path = 'message') {
  if (!isObj(m)) throw fail('InvalidParams', `${path} is required`, { violations: [{ field: path, message: 'is required' }] });
  const msg = version === '1.0' ? m : W.messageFromV03(m);
  const v = [];
  if (typeof msg.messageId !== 'string' || !msg.messageId) v.push({ field: `${path}.messageId`, message: 'is required' });
  if (msg.role !== 'ROLE_USER') v.push({ field: `${path}.role`, message: version === '1.0' ? 'must be ROLE_USER' : 'must be "user"' });
  if (!Array.isArray(msg.parts) || !msg.parts.length) v.push({ field: `${path}.parts`, message: 'At least one part is required' });
  else {
    msg.parts.forEach((p, i) => {
      const kinds = isObj(p) ? ['text', 'data', 'url', 'raw'].filter((k) => k in p) : [];
      if (kinds.length !== 1) v.push({ field: `${path}.parts[${i}]`, message: version === '1.0' ? 'must have exactly one of text, data, url or raw' : 'must be a text, data or file part' });
    });
  }
  if (v.length) throw fail('InvalidParams', 'Invalid parameters', { violations: v });
  return msg;
}

module.exports = function a2aRouter(ctx) {
  const { settings } = ctx;
  const engine = makeEngine(ctx);
  ctx.a2a = engine;
  const owner = (req) => (req.auth?.principal && settings.get('authMode') !== 'none' ? String(req.auth.principal) : null);

  // ---- one implementation of every operation, shared by the JSON-RPC and HTTP+JSON bindings ----
  // Returns { result } (already in the version's shape) or { stream(write, end) } for streaming operations.
  async function op(kind, version, p, req, forced) {
    switch (kind) {
      case 'send':
      case 'stream': {
        const message = readMessage(p.message, version);
        const cfg = isObj(p.configuration) ? p.configuration : {};
        const modes = Array.isArray(cfg.acceptedOutputModes) ? cfg.acceptedOutputModes : [];
        if (modes.length && !modes.some((m) => ['text/plain', 'application/json', '*/*', 'text/*'].includes(m))) {
          throw fail('ContentTypeNotSupported', `This agent answers in text/plain and application/json, not ${modes.join(', ')}`, { meta: { acceptedOutputModes: modes.join(',') } });
        }
        const push = version === '1.0' ? cfg.taskPushNotificationConfig : cfg.pushNotificationConfig;
        if (push !== undefined && (!isObj(push) || typeof push.url !== 'string')) throw fail('InvalidParams', 'Invalid parameters', { violations: [{ field: 'configuration.pushNotificationConfig.url', message: 'is required' }] });
        const historyLength = Number.isInteger(cfg.historyLength) ? cfg.historyLength : undefined;
        if (kind === 'stream') {
          // Start the task before the SSE response opens, so errors (unknown task, bad input) are ordinary errors.
          const buf = [];
          let sink = null;
          let finished = false;
          const listener = (ev) => {
            const out = W.streamResponse(ev, version);
            const fin = ev.statusUpdate && (W.TERMINAL.has(ev.statusUpdate.status.state) || W.INTERRUPTED.has(ev.statusUpdate.status.state));
            if (sink) { sink.write(out); if (fin) setImmediate(sink.end); } else { buf.push(out); if (fin) finished = true; }
          };
          const out = await engine.send(message, { owner: owner(req), forced, pushConfig: push, version, listener });
          if (out.message) return { stream: (write, end) => { write(W.streamResponse({ message: out.message }, version)); end(); return () => {}; } };
          return {
            stream: (write, end) => {
              for (const x of buf) write(x);
              if (finished) setImmediate(end); else sink = { write, end };
              return () => out.record.listeners.delete(listener);
            },
          };
        }
        const out = await engine.send(message, { owner: owner(req), forced, pushConfig: push, version });
        if (out.message) return { result: W.sendResult({ message: out.message }, version) };
        const wait = version === '1.0' ? cfg.returnImmediately !== true : cfg.blocking !== false;
        if (wait) await out.finished;
        return { result: W.sendResult({ task: engine.snapshot(out.record, historyLength) }, version) };
      }
      case 'get': {
        if (typeof p.id !== 'string') throw fail('InvalidParams', 'Invalid parameters', { violations: [{ field: 'id', message: 'is required' }] });
        const r = engine.get(p.id, owner(req));
        return { result: W.taskOut(engine.snapshot(r, Number.isInteger(p.historyLength) ? p.historyLength : undefined), version) };
      }
      case 'list': {
        const status = p.status === undefined || p.status === '' || p.status === 'TASK_STATE_UNSPECIFIED' ? undefined : p.status;
        if (status && !W.STATES.includes(status)) throw fail('InvalidParams', 'Invalid parameters', { violations: [{ field: 'status', message: `must be one of ${W.STATES.join(', ')}` }] });
        const pageSize = p.pageSize === undefined ? 50 : Number(p.pageSize);
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw fail('InvalidParams', 'Invalid parameters', { violations: [{ field: 'pageSize', message: 'must be an integer from 1 to 100' }] });
        return { result: engine.list({ owner: owner(req), contextId: p.contextId || undefined, status, pageSize, pageToken: p.pageToken || undefined, historyLength: p.historyLength === undefined ? undefined : Number(p.historyLength), includeArtifacts: p.includeArtifacts === true || p.includeArtifacts === 'true', statusTimestampAfter: p.statusTimestampAfter }) };
      }
      case 'cancel': {
        if (typeof p.id !== 'string') throw fail('InvalidParams', 'Invalid parameters', { violations: [{ field: 'id', message: 'is required' }] });
        return { result: W.taskOut(engine.snapshot(engine.cancel(p.id, owner(req))), version) };
      }
      case 'subscribe': {
        if (typeof p.id !== 'string') throw fail('InvalidParams', 'Invalid parameters', { violations: [{ field: 'id', message: 'is required' }] });
        const r = engine.get(p.id, owner(req));
        if (W.TERMINAL.has(r.task.status.state)) throw fail('UnsupportedOperation', `Task ${p.id} is ${r.task.status.state}; there is nothing more to stream`, { meta: { taskId: p.id } });
        return {
          stream: (write, end) => {
            write(W.streamResponse({ task: engine.snapshot(r) }, version));
            const l = (ev) => { write(W.streamResponse(ev, version)); if (ev.statusUpdate && (W.TERMINAL.has(ev.statusUpdate.status.state) || W.INTERRUPTED.has(ev.statusUpdate.status.state))) setImmediate(end); };
            r.listeners.add(l);
            if (W.INTERRUPTED.has(r.task.status.state)) setImmediate(end);
            return () => r.listeners.delete(l);
          },
        };
      }
      case 'pushCreate': {
        const taskId = p.taskId;
        const cfg = version === '1.0' ? p : p.pushNotificationConfig;
        if (typeof taskId !== 'string' || !isObj(cfg) || typeof cfg.url !== 'string') throw fail('InvalidParams', 'Invalid parameters', { violations: [{ field: version === '1.0' ? 'url' : 'pushNotificationConfig.url', message: 'taskId and url are required' }] });
        try { new URL(cfg.url); } catch { throw fail('InvalidParams', 'Invalid parameters', { violations: [{ field: 'url', message: 'must be an absolute URL' }] }); } // eslint-disable-line no-new
        const r = engine.get(taskId, owner(req));
        const stored = engine.addPush(r, cfg, version);
        return { result: pushOut(stored, version) };
      }
      case 'pushGet': {
        const taskId = version === '1.0' ? p.taskId : p.id;
        const id = version === '1.0' ? p.id : p.pushNotificationConfigId;
        const r = engine.get(taskId, owner(req));
        const c = id ? r.push.get(id) : [...r.push.values()][0];
        if (!c) throw fail('InvalidParams', `No push notification config ${id || ''} on task ${taskId}`.replace('  ', ' '), { meta: { taskId } });
        return { result: pushOut(c, version) };
      }
      case 'pushList': {
        const r = engine.get(version === '1.0' ? p.taskId : p.id, owner(req));
        const all = [...r.push.values()].map((c) => pushOut(c, version));
        return { result: version === '1.0' ? { configs: all, nextPageToken: '' } : all };
      }
      case 'pushDelete': {
        const taskId = version === '1.0' ? p.taskId : p.id;
        const id = version === '1.0' ? p.id : p.pushNotificationConfigId;
        const r = engine.get(taskId, owner(req));
        if (!r.push.delete(id)) throw fail('InvalidParams', `No push notification config ${id} on task ${taskId}`, { meta: { taskId } });
        return { result: version === '1.0' ? {} : null };
      }
      case 'card': {
        if (settings.get('authMode') === 'none') throw fail('ExtendedAgentCardNotConfigured', 'There is no extended Agent Card while AUTH_MODE is none (it adds skills for authenticated callers)');
        return { result: version === '1.0' ? card10(ctx, req, { extended: true }) : card03(ctx, req, { extended: true }) };
      }
      default: throw fail('MethodNotFound', 'Method not found');
    }
  }

  function pushOut(c, version) {
    const base = { id: c.id, url: c.url, ...(c.token ? { token: c.token } : {}), ...(c.authentication ? { authentication: c.authentication } : {}) };
    return version === '1.0' ? { taskId: c.taskId, ...base, createdAt: c.createdAt } : { taskId: c.taskId, pushNotificationConfig: base };
  }

  // In the oauth2 auth mode: "write" for messages that change data, otherwise "read".
  const scope = (req, res, next) => {
    let b = req.body;
    if (isObj(b) && isObj(b.params)) b = b.params;
    const m = isObj(b) && isObj(b.message) ? b.message : null;
    const text = m && Array.isArray(m.parts) ? m.parts.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ') : '';
    const data = m && Array.isArray(m.parts) ? m.parts.find((x) => x && isObj(x.data))?.data : null;
    let write = m ? engine.agent.looksLikeWrite(text, data) : false;
    if (m?.taskId) { const r = engine.tasks.get(m.taskId); if (r?.pending?.call?.write) write = true; }
    req.requiredScope = write ? 'write' : 'read';
    next();
  };
  const jsonBody = express.json({ limit: '10mb', type: ['application/json', 'application/a2a+json', 'application/*+json'], verify });

  // ---- SSE plumbing shared by both bindings ----
  function sse(req, res, wrap, forced) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    req.socket.setNoDelay?.(true);
    let sent = 0;
    let closed = false;
    const write = (obj) => {
      if (closed || res.writableEnded) return;
      sent += 1;
      const text = `data: ${JSON.stringify(wrap(obj))}\n\n`;
      if (forced === 'drop' && sent >= 2) { closed = true; res.write(text, () => res.socket?.destroy()); return; } // cut once this event is on the wire
      res.write(text);
    };
    const end = () => { if (!closed) { closed = true; res.end(); } };
    return { write, end, onClose: (f) => res.on('close', f) };
  }

  function forcedOf(req) {
    const f = String(req.get('x-force-a2a-error') || '').trim();
    if (!f) return '';
    if (!['fail', 'reject', 'input-required', 'auth-required', 'drop'].includes(f) && !/^rpc(:-?\d+)?$/.test(f)) {
      throw fail('InvalidRequest', 'X-Force-A2A-Error must be fail, reject, input-required, auth-required, rpc, rpc:<code> or drop');
    }
    return f;
  }

  // ---- JSON-RPC binding ----
  function jsonrpc(fixedVersion) {
    return async (req, res) => {
      const body = req.body;
      const send = (status, msg) => res.status(status).type('application/json').send(JSON.stringify(msg));
      const err = (id, e) => {
        const name = e instanceof A2AError ? e.a2a : 'Internal';
        if (!(e instanceof A2AError)) ctx.log('error', 'a2a', e.stack || e);
        return send(200, { jsonrpc: '2.0', id: id ?? null, error: rpcError(name, e.message, { meta: e.meta, violations: e.violations }) });
      };
      if (Array.isArray(body) || !isObj(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
        return send(400, { jsonrpc: '2.0', id: isObj(body) ? body.id ?? null : null, error: rpcError('InvalidRequest', 'Request payload validation error: send one JSON-RPC 2.0 request ({"jsonrpc": "2.0", "id", "method", "params"})') });
      }
      const { id, method } = body;
      const params = isObj(body.params) ? body.params : {};
      let version = fixedVersion || versionOf(req);
      try {
        if (fixedVersion && req.get('a2a-version') && versionOf(req) !== fixedVersion) throw fail('VersionNotSupported', `This endpoint speaks A2A ${fixedVersion}; it got A2A-Version ${versionOf(req)} (1.0 clients use ${ctx.baseUrl(req)}/a2a)`, { meta: { requested: versionOf(req), supported: fixedVersion } });
        const supported = ['1.0', ...(settings.get('a2aLegacy') ? ['0.3'] : [])];
        if (!supported.includes(version)) {
          const hint = version === '0.3' && !req.get('a2a-version') ? ' A request without an A2A-Version header is 0.3; send A2A-Version: 1.0.' : '';
          throw fail('VersionNotSupported', `A2A version ${version} is not supported.${hint}`, { meta: { requested: version, supported: supported.join(',') } });
        }
        const table = version === '1.0' ? V1 : V03;
        const kind = table[method];
        if (!kind) {
          const other = version === '1.0' ? V03[method] : V1[method];
          const hint = other ? (version === '1.0' ? ` ${method} is a 0.3 method; 1.0 uses ${Object.keys(V1).find((k) => V1[k] === other)}.` : ` ${method} is a 1.0 method: send the header A2A-Version: 1.0 (no header means 0.3).`) : '';
          throw fail('MethodNotFound', `Method not found: ${method}.${hint}`);
        }
        const forced = forcedOf(req);
        if (forced.startsWith('rpc')) {
          res.setHeader('X-Chaos-Injected', `a2a-${forced}`);
          const code = Number(forced.split(':')[1]) || -32603;
          return send(200, { jsonrpc: '2.0', id, error: { code, message: `JSON-RPC error forced by X-Force-A2A-Error: ${forced}` } });
        }
        if (forced) res.setHeader('X-Chaos-Injected', `a2a-${forced}`);
        const out = await op(kind, version, params, req, forced);
        if (out.stream) {
          const s = sse(req, res, (result) => ({ jsonrpc: '2.0', id, result }), forced);
          s.onClose(out.stream(s.write, s.end));
          return undefined;
        }
        return send(200, { jsonrpc: '2.0', id, result: out.result });
      } catch (e) {
        if (res.headersSent) { res.end(); return undefined; }
        return err(id, e);
      }
    };
  }

  // ---- HTTP+JSON binding (1.0) ----
  function rest() {
    const rr = express.Router();
    rr.use((req, res, next) => { req.errorFormat = 'a2a-rest'; next(); });
    rr.use(...protocolStack(ctx, { format: 'a2a-rest', body: [jsonBody, scope] }));
    const handle = (kind, params) => async (req, res) => {
      const reply = (status, body) => res.status(status).type('application/a2a+json').send(JSON.stringify(body));
      try {
        const v = versionOf(req);
        if (v !== '1.0') throw fail('VersionNotSupported', `The HTTP+JSON binding here speaks A2A 1.0; got ${req.get('a2a-version') ? v : 'no A2A-Version header (which means 0.3)'}. Send A2A-Version: 1.0.`, { meta: { requested: v, supported: '1.0' } });
        const forced = forcedOf(req);
        if (forced.startsWith('rpc')) throw fail('Internal', `Error forced by X-Force-A2A-Error: ${forced}`);
        if (forced) res.setHeader('X-Chaos-Injected', `a2a-${forced}`);
        const out = await op(kind, '1.0', params(req), req, forced);
        if (out.stream) {
          const s = sse(req, res, (x) => x, forced);
          s.onClose(out.stream(s.write, s.end));
          return undefined;
        }
        return reply(200, out.result);
      } catch (e) {
        if (res.headersSent) { res.end(); return undefined; }
        if (!(e instanceof A2AError)) ctx.log('error', 'a2a', e.stack || e);
        const x = restError(e instanceof A2AError ? e.a2a : 'Internal', e.message, { meta: e.meta, violations: e.violations });
        return reply(x.status, x.body);
      }
    };
    const body = (req) => (isObj(req.body) ? req.body : {});
    const query = (req) => {
      const q = { ...req.query };
      for (const k of ['pageSize', 'historyLength']) if (q[k] !== undefined) q[k] = Number(q[k]);
      return q;
    };
    // Paths contain ":" (e.g. /message:send), so they are matched here rather than by Express path patterns.
    rr.use(async (req, res, next) => {
      const p = req.path.replace(/^\/[^/:]+(?=\/(message|tasks|extendedAgentCard))/, ''); // optional /{tenant} prefix
      let m;
      if (req.method === 'POST' && p === '/message:send') return handle('send', body)(req, res);
      if (req.method === 'POST' && p === '/message:stream') return handle('stream', body)(req, res);
      if (req.method === 'GET' && p === '/tasks') return handle('list', query)(req, res);
      if (req.method === 'GET' && p === '/extendedAgentCard') return handle('card', () => ({}))(req, res);
      if ((m = /^\/tasks\/([^/:]+):cancel$/.exec(p)) && req.method === 'POST') return handle('cancel', (q) => ({ ...body(q), id: decodeURIComponent(m[1]) }))(req, res);
      if ((m = /^\/tasks\/([^/:]+):subscribe$/.exec(p)) && (req.method === 'GET' || req.method === 'POST')) return handle('subscribe', () => ({ id: decodeURIComponent(m[1]) }))(req, res);
      if ((m = /^\/tasks\/([^/:]+)\/pushNotificationConfigs$/.exec(p))) {
        if (req.method === 'POST') return handle('pushCreate', (q) => ({ ...body(q), taskId: decodeURIComponent(m[1]) }))(req, res);
        if (req.method === 'GET') return handle('pushList', () => ({ taskId: decodeURIComponent(m[1]) }))(req, res);
      }
      if ((m = /^\/tasks\/([^/:]+)\/pushNotificationConfigs\/([^/:]+)$/.exec(p))) {
        const ids = () => ({ taskId: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) });
        if (req.method === 'GET') return handle('pushGet', ids)(req, res);
        if (req.method === 'DELETE') return handle('pushDelete', ids)(req, res);
      }
      if ((m = /^\/tasks\/([^/:]+)$/.exec(p)) && req.method === 'GET') return handle('get', (q) => ({ ...query(q), id: decodeURIComponent(m[1]) }))(req, res);
      return next();
    });
    rr.use((req, res) => {
      const x = restError('MethodNotFound', `No A2A HTTP+JSON operation at ${req.method} ${req.originalUrl.split('?')[0]}`);
      res.status(x.status).type('application/a2a+json').send(JSON.stringify(x.body));
    });
    return rr;
  }

  const r = express.Router();
  r.use((req, res, next) => {
    req.errorFormat = 'a2a';
    if (!settings.get('a2aEnabled')) return sendProblem(req, res, 404, { detail: 'The A2A agent is disabled (A2A_ENABLED=false)', code: 'a2a-disabled' });
    next();
  });
  const cardRoute = (build) => (req, res) => {
    const card = build(ctx, req);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(card);
  };
  r.get('/.well-known/agent-card.json', cardRoute(card10));
  r.get('/v0.3/.well-known/agent-card.json', (req, res, next) => (settings.get('a2aLegacy') ? cardRoute(card03)(req, res) : next()));
  r.use('/rest', rest());
  const stack = protocolStack(ctx, { format: 'a2a', body: [jsonBody, scope] });
  r.post('/', ...stack, jsonrpc(null));
  r.post('/v0.3', ...stack, (req, res, next) => (settings.get('a2aLegacy') ? jsonrpc('0.3')(req, res) : next()));
  r.all(['/', '/v0.3'], (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: rpcError('InvalidRequest', `${req.method} is not supported here: POST JSON-RPC requests (the Agent Card is at /.well-known/agent-card.json)`) }));
  r.use((req, res) => res.status(404).json({ jsonrpc: '2.0', id: null, error: rpcError('MethodNotFound', `No A2A endpoint at ${req.originalUrl.split('?')[0]}`) }));
  return r;
};

// The Agent Card at the well-known URI on the server root.
module.exports.wellKnown = function a2aWellKnown(ctx) {
  const r = express.Router();
  r.get('/.well-known/agent-card.json', (req, res) => {
    if (!ctx.settings.get('a2aEnabled')) return res.status(404).json({ error: 'The A2A agent is disabled (A2A_ENABLED=false)' });
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(card10(ctx, req));
  });
  return r;
};
