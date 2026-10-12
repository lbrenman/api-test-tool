'use strict';
// /mcp — a mock MCP server (Streamable HTTP) over the shared mock data, for integrations that call MCP tools
// and for MCP proxies/gateways placed in front of a server.
//
// Dual-era, as the 2026-07-28 revision allows (basic/versioning, "Backward Compatibility"):
//   * Modern (2026-07-28): stateless. Every request carries io.modelcontextprotocol/protocolVersion (and
//     clientCapabilities) in params._meta, plus the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers
//     (and Mcp-Param-* for x-mcp-header tool arguments), which are checked against the body (-32020
//     HeaderMismatch). server/discover, subscriptions/listen, resultType and ttlMs/cacheScope are supported.
//   * Legacy (2025-11-25, 2025-06-18, 2025-03-26): an initialize request opens a session (Mcp-Session-Id),
//     followed by notifications/initialized, ping, logging/setLevel, resources/subscribe, a GET stream for
//     server notifications and DELETE to end the session.
//
// Requests go through the shared protocol stack (AUTH_MODE, rate limit, required headers, chaos); those
// errors are JSON-RPC shaped with their HTTP status (errors.js). Tools, resources and prompts: catalog.js.
// Chaos for MCP: X-Force-MCP-Error: tool | rpc[:code] | drop.
require('./errors');
const crypto = require('node:crypto');
const express = require('express');
const { sendProblem } = require('../../util/problem');
const { protocolStack } = require('../../middleware/protocol');
const { verify } = require('../../middleware/body');
const { makeCatalog, McpError } = require('./catalog');
const pkg = require('../../../package.json');

const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SUPPORTED = [MODERN, ...LEGACY];
const M = 'io.modelcontextprotocol/';
const SERVER_INFO = { name: 'api-test-tool-mcp', title: 'API Test Tool mock MCP server', version: pkg.version };
const INSTRUCTIONS = 'Mock business data (employees, products, departments, categories) and a file pool. Use the search_* tools to find records and get_* for full details; create/update/delete tools change the data for every protocol the tool serves.';
const NAMED = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };
const CACHE = { 'server/discover': [3600000, 'public'], 'tools/list': [60000, 'public'], 'prompts/list': [60000, 'public'], 'resources/templates/list': [60000, 'public'], 'resources/list': [10000, 'private'], 'resources/read': [5000, 'private'] };
const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Mcp-Name / Mcp-Param-* values may be "=?base64?…?=" encoded.
function decodeHeader(v) {
  if (typeof v !== 'string') return v;
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

class RpcFailure extends Error {
  constructor(httpStatus, code, message, data) { super(message); this.httpStatus = httpStatus; this.code = code; this.data = data; }
}

module.exports = function mcpRouter(ctx) {
  const { settings, baseUrl } = ctx;
  const catalog = makeCatalog(ctx);
  const sessions = new Map(); // legacy sessions: id -> { id, version, clientInfo, capabilities, logLevel, subscriptions:Set, streams:Set, lastSeen }
  const listeners = new Set(); // open notification streams: { filter(kind, uri) -> bool, send(notification) }
  ctx.mcpSessions = sessions;

  const allowWrites = () => settings.get('mcpAllowWrites');
  const capabilities = () => ({ tools: { listChanged: true }, resources: { subscribe: true, listChanged: true }, prompts: { listChanged: false }, completions: {}, logging: {} });

  // ---- server -> client notifications (subscriptions/listen streams and legacy GET streams) ----
  function broadcast(kind, uri) {
    for (const l of listeners) { try { l.deliver(kind, uri); } catch { /* a closed stream */ } }
  }
  ctx.events.on('change', (e) => {
    broadcast('resource', `att://${e.resource}/${e.id}`);
    if ((e.resource === 'departments' || e.resource === 'categories') && e.type !== 'updated') broadcast('resourcesList');
  });
  ctx.events.on('file', (e) => {
    if (e.type === 'downloaded') return;
    broadcast('resource', `att://files/${e.id}`);
    broadcast('resourcesList');
  });
  settings.on('change', ({ key }) => { if (key === 'mcpAllowWrites') broadcast('toolsList'); });

  const sweep = setInterval(() => {
    const ttl = settings.get('mcpSessionTtlMinutes') * 60000;
    for (const [id, s] of sessions) if (!s.streams.size && Date.now() - s.lastSeen > ttl) sessions.delete(id);
  }, 60000);
  sweep.unref();

  // ---- response writing ----
  // One response per POST: JSON, or an SSE stream (notifications first, then the response).
  function opener(req, res, { sse }) {
    let streaming = false;
    const start = () => {
      if (streaming) return;
      streaming = true;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      req.socket.setNoDelay?.(true);
    };
    const write = (msg) => { if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`); };
    return {
      get sse() { return sse; },
      notify(msg) { if (!sse) return; start(); write(msg); },
      finish(status, msg, headers = {}) {
        if (res.writableEnded || res.destroyed) return;
        if (sse && status === 200) { start(); write(msg); res.end(); return; }
        if (streaming) { write(msg); res.end(); return; }
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.status(status).type('application/json').send(JSON.stringify(msg));
      },
    };
  }

  const wantsSse = (req) => /text\/event-stream/.test(req.get('accept') || '');

  function decorate(method, result, era) {
    if (era !== 'modern') return result;
    const out = { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [`${M}serverInfo`]: SERVER_INFO } };
    if (CACHE[method]) { out.ttlMs = CACHE[method][0]; out.cacheScope = CACHE[method][1]; }
    return out;
  }

  // ---- method dispatch shared by both eras ----
  async function dispatch(method, params, x) {
    const p = isObj(params) ? params : {};
    switch (method) {
      case 'tools/list': return { tools: catalog.tools({ allowWrites: allowWrites() }) };
      case 'tools/call': {
        if (typeof p.name !== 'string') throw new McpError(-32602, 'params.name (the tool name) is required');
        if (x.forced === 'tool') return { content: [{ type: 'text', text: 'Tool error forced by X-Force-MCP-Error: tool' }], isError: true };
        const token = p._meta?.progressToken;
        const progress = token !== undefined ? (n, total, message) => x.notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: n, total, message } }) : undefined;
        x.log('info', { tool: p.name, message: `Running ${p.name}` });
        return catalog.callTool(p.name, p.arguments, { allowWrites: allowWrites(), progress, signal: x.signal });
      }
      case 'resources/list': return catalog.listResources(p.cursor);
      case 'resources/templates/list': return catalog.templates();
      case 'resources/read': {
        if (typeof p.uri !== 'string') throw new McpError(-32602, 'params.uri is required');
        try {
          return await catalog.readResource(p.uri);
        } catch (e) {
          // 2025-11-25 and earlier used -32002 for "resource not found"; 2026-07-28 uses -32602.
          if (x.era === 'legacy' && e instanceof McpError && /^Resource not found/.test(e.message)) throw new McpError(-32002, e.message, e.data);
          throw e;
        }
      }
      case 'prompts/list': return catalog.listPrompts();
      case 'prompts/get': {
        if (typeof p.name !== 'string') throw new McpError(-32602, 'params.name (the prompt name) is required');
        return catalog.getPrompt(p.name, isObj(p.arguments) ? p.arguments : {});
      }
      case 'completion/complete': return catalog.complete(p.ref, p.argument);
      default: return undefined;
    }
  }

  // ---- notification streams ----
  function openListener(req, res, { filter, tag, onClose }) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    req.socket.setNoDelay?.(true);
    req.socket.setTimeout?.(0);
    const send = (msg) => { if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`); };
    const l = {
      send,
      deliver(kind, uri) {
        const n = filter(kind, uri);
        if (!n) return;
        const params = { ...(n.params || {}), ...(tag !== undefined ? { _meta: { [`${M}subscriptionId`]: tag } } : {}) };
        send({ jsonrpc: '2.0', method: n.method, params });
      },
    };
    listeners.add(l);
    const ka = settings.get('mcpKeepAliveSeconds');
    const timer = ka ? setInterval(() => { if (!res.writableEnded) res.write(':\n\n'); }, ka * 1000) : null;
    const close = () => { listeners.delete(l); if (timer) clearInterval(timer); onClose?.(); };
    res.on('close', close);
    return l;
  }

  const r = express.Router();

  r.use((req, res, next) => {
    req.errorFormat = 'jsonrpc';
    if (!settings.get('mcpEnabled')) return sendProblem(req, res, 404, { detail: 'The MCP mock is disabled (MCP_ENABLED=false)', code: 'mcp-disabled' });
    // Origin check (DNS rebinding protection): a browser Origin must be this server or one of CORS_ORIGINS.
    const origin = req.get('origin');
    const allowed = String(settings.get('corsOrigins') || '*').split(',').map((s) => s.trim());
    if (origin && !allowed.includes('*') && !allowed.includes(origin) && origin !== new URL(baseUrl(req)).origin) {
      return res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32003, message: `Origin ${origin} is not allowed` } });
    }
    next();
  });

  // Scope for the oauth2 auth mode: reading needs "read"; a tool that changes data needs "write".
  const scope = (req, res, next) => {
    const b = req.body;
    const def = isObj(b) && b.method === 'tools/call' && isObj(b.params) ? catalog.toolDef(b.params.name) : null;
    req.requiredScope = def && def.write ? 'write' : 'read';
    next();
  };
  const stack = protocolStack(ctx, { format: 'jsonrpc', body: [express.json({ limit: '10mb', type: ['application/json', 'application/*+json'], verify }), scope] });

  r.post('/', ...stack, async (req, res) => {
    const body = req.body;
    const sessionId = req.get('mcp-session-id');
    const forced = (req.get('x-force-mcp-error') || '').trim();
    const reply = (status, msg, headers) => { res.status(status); for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v); res.type('application/json').send(JSON.stringify(msg)); };
    const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

    if (Array.isArray(body)) return reply(400, rpcError(null, -32600, 'JSON-RPC batches are not supported (removed in protocol version 2025-06-18); send one message per POST'));
    if (!isObj(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      if (isObj(body) && ('result' in body || 'error' in body)) return reply(400, rpcError(body.id, -32600, 'This server sends no requests, so it accepts no JSON-RPC responses'));
      return reply(400, rpcError(isObj(body) ? body.id : null, -32600, 'Invalid Request: the body must be a JSON-RPC 2.0 request or notification ({"jsonrpc": "2.0", "method": …})'));
    }
    const { method } = body;
    const isNotification = !('id' in body);
    const id = body.id;
    const params = isObj(body.params) ? body.params : {};
    const meta = isObj(params._meta) ? params._meta : {};
    const headerVersion = req.get('mcp-protocol-version');
    const metaVersion = meta[`${M}protocolVersion`];
    const validate = settings.get('mcpValidateHeaders');

    if (forced === 'drop') { res.setHeader('X-Chaos-Injected', 'mcp-drop'); res.socket?.destroy(); return undefined; }

    // ---- which era? ----
    let era;
    let session = null;
    if (sessionId !== undefined) {
      if (!settings.get('mcpLegacy')) return reply(400, rpcError(id, -32600, 'Sessions (Mcp-Session-Id) are not supported: this server only speaks protocol version 2026-07-28'));
      session = sessions.get(sessionId);
      if (!session) return reply(404, rpcError(id, -32001, `Session ${sessionId} not found or expired; send a new initialize request`));
      era = 'legacy';
    } else if (method === 'initialize') {
      era = 'init';
    } else if (metaVersion !== undefined || headerVersion === MODERN) {
      era = 'modern';
    } else {
      if (isNotification) return res.status(202).end();
      return reply(400, rpcError(id, -32600, `No session and no protocol version: send initialize first (legacy clients, Mcp-Session-Id), or put "${M}protocolVersion": "${MODERN}" in params._meta`, { supported: SUPPORTED }));
    }

    // ---- legacy: initialize ----
    if (era === 'init') {
      const requested = params.protocolVersion;
      if (!settings.get('mcpLegacy')) {
        return reply(400, rpcError(id, -32022, `Unsupported protocol version: this server does not use initialize; it speaks ${MODERN} (send ${M}protocolVersion in params._meta)`, { supported: [MODERN], requested: requested ?? null }));
      }
      const version = LEGACY.includes(requested) ? requested : LEGACY[0];
      const sid = crypto.randomUUID();
      sessions.set(sid, { id: sid, version, clientInfo: params.clientInfo || null, capabilities: params.capabilities || {}, logLevel: null, subscriptions: new Set(), streams: new Set(), createdAt: new Date().toISOString(), lastSeen: Date.now() });
      const result = { protocolVersion: version, capabilities: capabilities(), serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
      const o = opener(req, res, { sse: settings.get('mcpResponseMode') === 'sse' && wantsSse(req) });
      return o.finish(200, { jsonrpc: '2.0', id, result }, { 'Mcp-Session-Id': sid });
    }

    // ---- legacy: an existing session ----
    if (era === 'legacy') {
      session.lastSeen = Date.now();
      if (headerVersion && headerVersion !== session.version) {
        return reply(400, rpcError(id, -32600, `MCP-Protocol-Version ${headerVersion} does not match the session's negotiated version ${session.version}`));
      }
      if (isNotification) return res.status(202).end(); // notifications/initialized, notifications/cancelled, …
      if (method === 'ping') return reply(200, { jsonrpc: '2.0', id, result: {} });
      if (method === 'logging/setLevel') {
        if (!LEVELS.includes(params.level)) return reply(200, rpcError(id, -32602, `level must be one of ${LEVELS.join(', ')}`));
        session.logLevel = params.level;
        return reply(200, { jsonrpc: '2.0', id, result: {} });
      }
      if (method === 'resources/subscribe' || method === 'resources/unsubscribe') {
        if (typeof params.uri !== 'string') return reply(200, rpcError(id, -32602, 'params.uri is required'));
        if (method === 'resources/subscribe') session.subscriptions.add(params.uri); else session.subscriptions.delete(params.uri);
        return reply(200, { jsonrpc: '2.0', id, result: {} });
      }
    }

    // ---- modern: header validation and version check ----
    if (era === 'modern') {
      try {
        if (metaVersion === undefined) throw new RpcFailure(400, -32602, `params._meta["${M}protocolVersion"] is required`);
        if (!SUPPORTED.includes(metaVersion) || LEGACY.includes(metaVersion)) {
          throw new RpcFailure(400, -32022, 'Unsupported protocol version', { supported: SUPPORTED, requested: metaVersion });
        }
        if (validate) {
          if (headerVersion === undefined) throw new RpcFailure(400, -32020, 'Header mismatch: the MCP-Protocol-Version header is required');
          if (headerVersion !== metaVersion) throw new RpcFailure(400, -32020, `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${metaVersion}'`);
          if (!isNotification) {
            const mh = req.get('mcp-method');
            if (mh === undefined) throw new RpcFailure(400, -32020, 'Header mismatch: the Mcp-Method header is required');
            if (mh !== method) throw new RpcFailure(400, -32020, `Header mismatch: Mcp-Method header value '${mh}' does not match body value '${method}'`);
            if (NAMED[method]) {
              const want = params[NAMED[method]];
              const nh = req.get('mcp-name');
              if (nh === undefined) throw new RpcFailure(400, -32020, `Header mismatch: the Mcp-Name header is required for ${method}`);
              if (decodeHeader(nh) !== want) throw new RpcFailure(400, -32020, `Header mismatch: Mcp-Name header value '${decodeHeader(nh)}' does not match body value '${want}'`);
            }
            if (method === 'tools/call') {
              const def = catalog.toolDef(params.name);
              const args = isObj(params.arguments) ? params.arguments : {};
              for (const [prop, s] of Object.entries(def?.inputSchema?.properties || {})) {
                if (!s['x-mcp-header']) continue;
                const hv = req.get(`mcp-param-${s['x-mcp-header']}`);
                const bv = args[prop];
                if (bv === undefined || bv === null) continue;
                if (hv === undefined) throw new RpcFailure(400, -32020, `Header mismatch: Mcp-Param-${s['x-mcp-header']} is required when the "${prop}" argument is set`);
                if (decodeHeader(hv) !== String(bv)) throw new RpcFailure(400, -32020, `Header mismatch: Mcp-Param-${s['x-mcp-header']} header value '${decodeHeader(hv)}' does not match body value '${bv}'`);
              }
            }
          }
        }
        if (validate && !isNotification) {
          const accept = req.get('accept') || '';
          if (!/application\/json|\*\/\*/.test(accept) || !/text\/event-stream|\*\/\*/.test(accept)) throw new RpcFailure(406, -32600, 'Not Acceptable: the Accept header must list both application/json and text/event-stream');
        }
        if (!isNotification && !isObj(meta[`${M}clientCapabilities`])) throw new RpcFailure(400, -32602, `params._meta["${M}clientCapabilities"] is required (use {} for none)`);
      } catch (e) {
        if (!(e instanceof RpcFailure)) throw e;
        return reply(e.httpStatus, rpcError(id, e.code, e.message, e.data));
      }
      if (isNotification) return res.status(202).end();
      if (['ping', 'logging/setLevel', 'resources/subscribe', 'resources/unsubscribe', 'initialize'].includes(method)) {
        return reply(404, rpcError(id, -32601, `Method not found: ${method} is not part of protocol version ${MODERN}`));
      }
      if (method === 'server/discover') {
        return reply(200, { jsonrpc: '2.0', id, result: decorate(method, { supportedVersions: SUPPORTED, capabilities: capabilities(), instructions: INSTRUCTIONS }, 'modern') });
      }
      if (method === 'subscriptions/listen') {
        const want = isObj(params.notifications) ? params.notifications : {};
        const ack = {};
        if (want.toolsListChanged === true) ack.toolsListChanged = true;
        if (want.resourcesListChanged === true) ack.resourcesListChanged = true;
        if (Array.isArray(want.resourceSubscriptions)) ack.resourceSubscriptions = want.resourceSubscriptions.filter((u) => typeof u === 'string');
        // promptsListChanged: the prompt list never changes here, so it is left out of the acknowledgement.
        const uris = new Set(ack.resourceSubscriptions || []);
        const l = openListener(req, res, {
          tag: id,
          filter: (kind, uri) => {
            if (kind === 'toolsList' && ack.toolsListChanged) return { method: 'notifications/tools/list_changed' };
            if (kind === 'resourcesList' && ack.resourcesListChanged) return { method: 'notifications/resources/list_changed' };
            if (kind === 'resource' && uris.has(uri)) return { method: 'notifications/resources/updated', params: { uri } };
            return null;
          },
        });
        l.send({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { _meta: { [`${M}subscriptionId`]: id }, notifications: ack } });
        return undefined;
      }
    }

    // ---- shared methods ----
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    const mode = settings.get('mcpResponseMode');
    const progressWanted = method === 'tools/call' && params._meta?.progressToken !== undefined;
    const sse = wantsSse(req) && (mode === 'sse' || (mode === 'auto' && progressWanted));
    const o = opener(req, res, { sse });
    const level = era === 'modern' ? meta[`${M}logLevel`] : session?.logLevel;
    const log = (lvl, data) => {
      if (!level || LEVELS.indexOf(lvl) < LEVELS.indexOf(level)) return;
      o.notify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: lvl, logger: 'api-test-tool', data } });
    };
    if (forced.startsWith('rpc')) {
      const code = Number(forced.split(':')[1]) || -32603;
      res.setHeader('X-Chaos-Injected', `mcp-rpc=${code}`);
      return o.finish(200, rpcError(id, code, `JSON-RPC error forced by X-Force-MCP-Error: ${forced}`));
    }
    if (forced === 'tool') res.setHeader('X-Chaos-Injected', 'mcp-tool');
    else if (forced && forced !== 'tool') return reply(400, rpcError(id, -32600, 'X-Force-MCP-Error must be tool, rpc, rpc:<code> or drop'));
    try {
      const result = await dispatch(method, params, { era, forced, signal: abort.signal, notify: (m) => o.notify(m), log });
      if (result === undefined) {
        const status = era === 'modern' ? 404 : 200;
        return o.finish(status, rpcError(id, -32601, `Method not found: ${method}`));
      }
      if (abort.signal.aborted) return undefined;
      return o.finish(200, { jsonrpc: '2.0', id, result: decorate(method, result, era) });
    } catch (e) {
      if (e instanceof McpError) return o.finish(200, rpcError(id, e.code, e.message, e.data));
      ctx.log('error', 'mcp', method, e.stack || e);
      return o.finish(200, rpcError(id, -32603, `Internal error: ${e.message}`));
    }
  });

  // Legacy (2025-03-26 … 2025-11-25): GET opens the session's server-notification stream; DELETE ends the session.
  // Modern clients never use them: without a session they get 405, as the 2026-07-28 transport requires.
  r.get('/', ...stack, (req, res) => {
    const s = sessions.get(req.get('mcp-session-id') || '');
    if (!req.get('mcp-session-id') || !settings.get('mcpLegacy')) {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Method Not Allowed: POST JSON-RPC messages to this endpoint (protocol version ${MODERN} has no GET stream; legacy clients need an Mcp-Session-Id from initialize)` } });
    }
    if (!s) return res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found or expired; send a new initialize request' } });
    s.lastSeen = Date.now();
    const l = openListener(req, res, {
      filter: (kind, uri) => {
        if (kind === 'toolsList') return { method: 'notifications/tools/list_changed' };
        if (kind === 'resourcesList') return { method: 'notifications/resources/list_changed' };
        if (kind === 'resource' && s.subscriptions.has(uri)) return { method: 'notifications/resources/updated', params: { uri } };
        return null;
      },
      onClose: () => { s.streams.delete(l); s.lastSeen = Date.now(); },
    });
    s.streams.add(l);
    return undefined;
  });

  r.delete('/', ...stack, (req, res) => {
    const sid = req.get('mcp-session-id');
    if (!sid || !settings.get('mcpLegacy')) {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed: there is no session to delete' } });
    }
    if (!sessions.delete(sid)) return res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found or expired' } });
    return res.status(204).end();
  });

  r.all('/', (req, res) => { res.setHeader('Allow', 'POST, GET, DELETE'); res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `${req.method} is not supported on /mcp` } }); });
  r.use((req, res) => res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32601, message: `No MCP endpoint at ${req.originalUrl.split('?')[0]}; the endpoint is /mcp` } }));
  return r;
};

// OAuth 2.0 Protected Resource Metadata (RFC 9728) for /mcp: how MCP clients find the authorization server.
module.exports.wellKnown = function mcpWellKnown(ctx) {
  const r = express.Router();
  const doc = (req) => {
    const base = ctx.baseUrl(req);
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ['read', 'write'],
      bearer_methods_supported: ['header'],
      resource_name: 'API Test Tool mock MCP server',
      resource_documentation: 'https://github.com/lbrenman/api-test-tool#mcp-server',
    };
  };
  r.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
    if (!ctx.settings.get('mcpEnabled')) return res.status(404).json({ error: 'not_found', error_description: 'The MCP mock is disabled (MCP_ENABLED=false)' });
    return res.json(doc(req));
  });
  return r;
};

module.exports.MODERN = MODERN;
module.exports.SUPPORTED = SUPPORTED;
