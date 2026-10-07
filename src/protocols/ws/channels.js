'use strict';
// Behaviour of the mock WebSocket channels. Each handler gets an open WsConnection.
//   echo     every message is sent straight back (text or binary)
//   rpc      JSON-RPC 2.0 style request/response over the mock data (correlated by "id")
//   changes  pushes created/updated/deleted events for the mock data (from any protocol)
const { NAMES } = require('../../services/resources');

const RESOURCE_BY_METHOD = {
  getEmployee: 'employees', getProduct: 'products', getDepartment: 'departments', getCategory: 'categories',
  listEmployees: 'employees', listProducts: 'products', listDepartments: 'departments', listCategories: 'categories',
};
const RPC_METHODS = ['ping', 'echo', 'time', ...Object.keys(RESOURCE_BY_METHOD)];

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

async function rpcCall(ctx, msg) {
  const { id, method, params = {} } = msg;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request: "method" must be a string');
  if (!RPC_METHODS.includes(method)) return rpcError(id, -32601, `Method not found: ${method}`, { methods: RPC_METHODS });
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return rpcError(id, -32602, 'Invalid params: "params" must be an object');
  const ok = (result) => ({ jsonrpc: '2.0', id: id ?? null, result });
  if (method === 'ping') return ok({ pong: true, time: new Date().toISOString() });
  if (method === 'time') return ok({ time: new Date().toISOString(), epochMs: Date.now() });
  if (method === 'echo') return ok(params);
  const name = RESOURCE_BY_METHOD[method];
  if (method.startsWith('get')) {
    const n = Number(params.id);
    if (!Number.isInteger(n) || n < 1) return rpcError(id, -32602, 'Invalid params: "id" must be a positive integer');
    const doc = await ctx.resources.get(name, n);
    if (!doc) return rpcError(id, -32004, `${name.replace(/ies$/, 'y').replace(/s$/, '')} ${n} not found`);
    const [out] = await ctx.resources.render(name, [doc]);
    return ok(ctx.dates.formatDoc(out));
  }
  const limit = params.limit === undefined ? 10 : Number(params.limit);
  const offset = params.offset === undefined ? 0 : Number(params.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    return rpcError(id, -32602, 'Invalid params: limit must be 1-100 and offset >= 0');
  }
  const all = await ctx.resources.all(name);
  const items = await ctx.resources.render(name, all.slice(offset, offset + limit));
  return ok({ items: items.map((d) => ctx.dates.formatDoc(d)), total: all.length, limit, offset });
}

const CHANNELS = {
  echo(conn) {
    conn.on('message', (m) => conn.send(m.data, { binary: m.binary }));
  },

  rpc(conn, req, ctx) {
    conn.on('message', async (m) => {
      if (m.binary) { conn.send(JSON.stringify(rpcError(null, -32700, 'Parse error: binary frames are not supported on /ws/rpc'))); return; }
      let msg;
      try { msg = JSON.parse(m.data); } catch (e) { conn.send(JSON.stringify(rpcError(null, -32700, `Parse error: ${e.message}`))); return; }
      const batch = Array.isArray(msg);
      const list = batch ? msg : [msg];
      if (!list.length || list.some((x) => !x || typeof x !== 'object')) { conn.send(JSON.stringify(rpcError(null, -32600, 'Invalid Request'))); return; }
      const out = [];
      for (const x of list) {
        try { out.push(await rpcCall(ctx, x)); } catch (e) { out.push(rpcError(x.id, -32603, `Internal error: ${e.message}`)); }
      }
      if (conn.open) conn.send(JSON.stringify(batch ? out : out[0]));
    });
  },

  changes(conn, req, ctx) {
    const want = String(req.query.resource || '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = want.filter((w) => !NAMES.includes(w));
    if (bad.length) { conn.close(1008, `Unknown resource ${bad.join(', ')}`); return; }
    const onChange = (e) => {
      if (want.length && !want.includes(e.resource)) return;
      if (conn.open) conn.send(JSON.stringify({ ...e, ...(e.data ? { data: ctx.dates.formatDoc(e.data) } : {}) }));
    };
    ctx.events.on('change', onChange);
    conn.on('close', () => ctx.events.off('change', onChange));
    conn.send(JSON.stringify({ type: 'subscribed', resources: want.length ? want : NAMES, at: new Date().toISOString() }));
  },
};

module.exports = { CHANNELS, RPC_METHODS, rpcCall };
