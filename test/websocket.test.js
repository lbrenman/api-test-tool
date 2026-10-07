'use strict';
// WebSocket: the mock channels (/ws/echo, /ws/rpc, /ws/changes) through the shared stack, and the
// WebSocket contract tester (AsyncAPI 3.0 / 2.x and scripted scenarios) against them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { listen } = require('./helpers');
const { connect, encodeFrame, OP } = require('../src/util/websocket');

let t;
let wsBase;
before(async () => { t = await listen({ SEED_SAMPLE_FILES: 'false' }); wsBase = t.url.replace(/^http/, 'ws'); });
after(async () => { await t.stop(); });

const api = () => request(t.app);
const set = (k, v) => t.ctx.settings.set(k, v);

// Connect and collect messages; returns helpers.
async function open(path, opts = {}) {
  const r = await connect(`${wsBase}${path}`, opts);
  if (!r.conn) return r;
  const messages = [];
  const waiters = [];
  r.conn.on('message', (m) => { messages.push(m); waiters.splice(0).forEach((f) => f()); });
  r.closed = new Promise((resolve) => r.conn.on('close', resolve));
  r.conn.on('error', () => {});
  r.messages = messages;
  r.next = (n = messages.length + 1, ms = 3000) => new Promise((resolve, reject) => {
    const done = () => { if (messages.length >= n) { clearTimeout(timer); resolve(messages[n - 1]); } else waiters.push(done); };
    const timer = setTimeout(() => reject(new Error(`timed out waiting for message ${n}`)), ms);
    done();
  });
  r.json = async (n) => JSON.parse((await r.next(n)).data);
  return r;
}

test('channel list, AsyncAPI document and 426 without an upgrade', async () => {
  const list = (await api().get('/ws').expect(200)).body;
  assert.deepEqual(list.channels.map((c) => c.name), ['echo', 'rpc', 'changes']);
  assert.equal(list.channels[1].url, `${wsBase}/ws/rpc`);
  const doc = (await api().get('/ws/asyncapi.json').expect(200)).body;
  assert.equal(doc.asyncapi, '3.0.0');
  assert.equal(doc.servers.mock.protocol, 'ws');
  assert.deepEqual(Object.keys(doc.channels), ['echo', 'rpc', 'changes']);
  const r = await api().get('/ws/echo').expect(426);
  assert.equal(r.get('Upgrade'), 'websocket');
  await api().get('/ws/nope').expect(404);
});

test('echo works with our client and with the built-in WebSocket', async () => {
  const c = await open('/ws/echo', { protocols: ['v1.json', 'v2'] });
  assert.equal(c.status, 101);
  assert.equal(c.protocol, 'v1.json');
  assert.ok(c.headers['x-request-id']);
  c.conn.send('hello');
  assert.equal((await c.next(1)).data, 'hello');
  c.conn.send(Buffer.from([1, 2, 3]));
  const bin = await c.next(2);
  assert.ok(bin.binary);
  assert.deepEqual([...bin.data], [1, 2, 3]);
  c.conn.close(1000, 'bye');
  assert.equal((await c.closed).code, 1000);

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws/echo`);
    ws.onopen = () => ws.send('builtin');
    ws.onmessage = (e) => { assert.equal(e.data, 'builtin'); ws.close(1000); };
    ws.onclose = (e) => { assert.equal(e.code, 1000); resolve(); };
    ws.onerror = reject;
  });
});

test('rpc: results match /v1, errors use JSON-RPC codes, batches work', async () => {
  const rest = (await api().get('/v1/employees/1').expect(200)).body;
  const c = await open('/ws/rpc');
  c.conn.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'getEmployee', params: { id: 1 } }));
  const r1 = await c.json(1);
  assert.equal(r1.id, 7);
  assert.equal(r1.result.email, rest.email);
  c.conn.send('{oops');
  assert.equal((await c.json(2)).error.code, -32700);
  c.conn.send(JSON.stringify({ id: 'x', method: 'nope' }));
  assert.equal((await c.json(3)).error.code, -32601);
  c.conn.send(JSON.stringify({ id: 9, method: 'getEmployee', params: { id: 999999 } }));
  assert.equal((await c.json(4)).error.code, -32004);
  c.conn.send(JSON.stringify([{ id: 1, method: 'ping' }, { id: 2, method: 'listDepartments', params: { limit: 2 } }]));
  const batch = await c.json(5);
  assert.equal(batch.length, 2);
  assert.equal(batch[1].result.items.length, 2);
  c.conn.close();
  await c.closed;
});

test('changes: events from any protocol, filtered by resource', async () => {
  const all = await open('/ws/changes');
  const emp = await open('/ws/changes?resource=employees');
  assert.equal((await all.json(1)).type, 'subscribed');
  assert.deepEqual((await emp.json(1)).resources, ['employees']);
  const d = (await api().post('/v1/departments').send({ name: 'WS Dept', code: 'WSD' }).expect(201)).body;
  const ev = await all.json(2);
  assert.equal(ev.type, 'created');
  assert.equal(ev.resource, 'departments');
  assert.equal(ev.id, d.id);
  await api().delete(`/v1/departments/${d.id}`).expect(204);
  assert.equal((await all.json(3)).type, 'deleted');
  assert.equal(emp.messages.length, 1); // employees only
  const bad = await open('/ws/changes?resource=nope');
  assert.equal((await bad.closed).code, 1008);
  all.conn.close(); emp.conn.close();
  await Promise.all([all.closed, emp.closed]);
});

test('the upgrade goes through auth, chaos and the inspector', async () => {
  await set('authMode', 'basic');
  try {
    const denied = await connect(`${wsBase}/ws/echo`);
    assert.equal(denied.status, 401);
    assert.equal(denied.conn, null);
    assert.match(denied.headers['content-type'], /problem\+json/);
    assert.match(denied.headers['www-authenticate'], /^Basic /);
    const ok = await open('/ws/echo', { headers: { Authorization: `Basic ${Buffer.from('demo:demo').toString('base64')}` } });
    assert.equal(ok.status, 101);
    ok.conn.close();
    await ok.closed;
  } finally { await set('authMode', 'none'); }

  await set('authMode', 'bearer');
  try {
    const q = await open('/ws/echo?access_token=demo-token');
    assert.equal(q.status, 101);
    q.conn.close();
    await q.closed;
    assert.equal((await connect(`${wsBase}/ws/echo?access_token=wrong`)).status, 401);
  } finally { await set('authMode', 'none'); }

  const chaos = await connect(`${wsBase}/ws/echo`, { headers: { 'X-Force-Error': '503' } });
  assert.equal(chaos.status, 503);
  assert.equal(chaos.headers['x-chaos-injected'], '503');

  const c = await open('/ws/echo', { headers: { 'X-Request-Id': 'ws-inspect-1' } });
  c.conn.close();
  await c.closed;
  await new Promise((r) => setTimeout(r, 100));
  const captures = (await api().get('/admin/api/inspector').expect(200)).body;
  const items = Array.isArray(captures) ? captures : captures.items || captures.captures || [];
  const hit = items.find((x) => x.path === '/ws/echo' && x.kind === 'ws');
  assert.ok(hit, 'upgrade recorded');
  assert.equal(hit.status ?? hit.response?.status, 101);
});

test('limits: message size (1009), invalid UTF-8 (1007), idle timeout (1001), disabled', async () => {
  await set('wsMaxMessageKb', 1);
  try {
    const c = await open('/ws/echo');
    c.conn.send('x'.repeat(2048));
    assert.equal((await c.closed).code, 1009);
  } finally { await set('wsMaxMessageKb', 1024); }

  const u = await open('/ws/echo');
  u.conn.sendRaw(encodeFrame(OP.TEXT, Buffer.from([0xff, 0xfe]), { mask: true }));
  assert.equal((await u.closed).code, 1007);

  await set('wsIdleTimeoutSeconds', 1);
  try {
    const i = await open('/ws/echo');
    const closed = await Promise.race([i.closed, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 4000))]);
    assert.equal(closed.code, 1001);
  } finally { await set('wsIdleTimeoutSeconds', 0); }

  await set('wsEnabled', false);
  try {
    assert.equal((await connect(`${wsBase}/ws/echo`)).status, 404);
  } finally { await set('wsEnabled', true); }
});

// ---------------------------------------------------------------- tester
const failures = (run) => run.steps.filter((s) => s.outcome === 'fail').map((s) => `${s.kind}:${s.test || ''} ${s.opId} ${JSON.stringify(s.checks.filter((c) => c.status === 'fail'))}`);

async function loadSelfWs() {
  const r = await api().post('/admin/api/tester/specs').send({ sample: 'self-ws' }).expect(201);
  assert.equal(r.body.kind, 'asyncapi');
  return r.body.id;
}

test('tester: the live AsyncAPI loads; try it on rpc and echo passes', async () => {
  const id = await loadSelfWs();
  const spec = (await api().get(`/admin/api/tester/specs/${id}`).expect(200)).body;
  assert.equal(spec.target.baseUrl, `${wsBase}/ws`);
  assert.deepEqual(spec.operations.map((o) => o.id), ['echo', 'rpc', 'changes']);
  assert.deepEqual(spec.operations[1].ws, { toServer: ['RpcRequest'], fromServer: ['RpcResponse'] });
  assert.equal(spec.lint.error, 0);
  assert.ok(spec.autoScenario.length > 0);

  const req = (await api().get(`/admin/api/tester/specs/${id}/request`).query({ op: 'rpc' }).expect(200)).body;
  assert.equal(req.body.method, 'getEmployee');
  const rpc = (await api().post(`/admin/api/tester/specs/${id}/send`).send({ opId: 'rpc' }).expect(200)).body;
  assert.equal(rpc.outcome, 'pass', JSON.stringify(rpc.checks));
  for (const n of ['upgrade', 'message[1]', 'reply', 'correlation', 'close']) assert.ok(rpc.checks.some((c) => c.name === n && c.status === 'pass'), n);
  assert.equal(rpc.response.status, 101);
  assert.match(rpc.response.body, /"result"/);

  const echo = (await api().post(`/admin/api/tester/specs/${id}/send`).send({ opId: 'echo' }).expect(200)).body;
  assert.equal(echo.outcome, 'pass', JSON.stringify(echo.checks));
});

test('tester: run all with negative tests passes against this tool; auth negative', async () => {
  const id = await loadSelfWs();
  const run = (await api().post(`/admin/api/tester/specs/${id}/runs`).send({ negative: true }).expect(201)).body;
  assert.equal(run.kind, 'asyncapi');
  assert.deepEqual(failures(run), []);
  const negs = run.steps.filter((s) => s.kind === 'negative').map((s) => `${s.test}:${s.outcome}`);
  assert.deepEqual(negs, ['malformed-message:pass', 'oversized-message:pass', 'invalid-utf8:pass']);

  await set('authMode', 'bearer');
  try {
    await api().put(`/admin/api/tester/specs/${id}`).send({ target: { auth: { type: 'bearer', token: 'demo-token' } } }).expect(200);
    const r2 = (await api().post(`/admin/api/tester/specs/${id}/runs`).send({ negative: true }).expect(201)).body;
    assert.deepEqual(failures(r2), []);
    const noAuth = r2.steps.find((s) => s.test === 'no-auth');
    assert.equal(noAuth.outcome, 'pass');
    assert.equal(noAuth.response.status, 401);
  } finally { await set('authMode', 'none'); }
});

test('tester: scripted scenario without a contract, with captures and templates', async () => {
  const r = await api().post('/admin/api/tester/specs').send({ kind: 'websocket', url: `${wsBase}/ws/rpc`, name: 'scripted' }).expect(201);
  assert.equal(r.body.kind, 'websocket');
  const id = r.body.id;
  const scenario = [
    { connect: {} },
    { send: { jsonrpc: '2.0', id: 1, method: 'getEmployee', params: { id: 1 } } },
    { expect: { match: { '/result/id': 1 }, capture: { dept: '/result/departmentId' } } },
    { send: { jsonrpc: '2.0', id: 2, method: 'getDepartment', params: { id: '{{dept}}' } } },
    { expect: { timeoutMs: 3000 } },
    { ping: {} },
    { close: 1000 },
  ];
  await api().put(`/admin/api/tester/specs/${id}`).send({ scenario }).expect(200);
  await api().put(`/admin/api/tester/specs/${id}`).send({ scenario: 'nope' }).expect(400);
  const run = (await api().post(`/admin/api/tester/specs/${id}/runs`).send({}).expect(201)).body;
  assert.deepEqual(failures(run), []);
  assert.ok(run.variables.dept);
  assert.equal(run.steps.length, 7);
  const doc = await api().get(`/admin/api/tester/specs/${id}/document`).expect(200);
  assert.equal(JSON.parse(doc.text).scenario.length, 7);
});

test('tester: AsyncAPI 2.x and a contract violation in a received message', async () => {
  const v2 = {
    asyncapi: '2.6.0',
    info: { title: 'Echo 2.x', version: '1' },
    servers: { local: { url: `${wsBase}/ws`, protocol: 'ws' } },
    channels: {
      '/echo': {
        publish: { message: { name: 'Greeting', payload: { type: 'object', required: ['hello'], properties: { hello: { type: 'string' } } }, examples: [{ payload: { hello: 'world' } }] } },
        subscribe: { message: { name: 'Answer', payload: { type: 'object', required: ['answer'], properties: { answer: { type: 'integer' } } } } },
      },
    },
  };
  const id = (await api().post('/admin/api/tester/specs').send({ content: JSON.stringify(v2) }).expect(201)).body.id;
  const spec = (await api().get(`/admin/api/tester/specs/${id}`).expect(200)).body;
  assert.equal(spec.kind, 'asyncapi');
  assert.deepEqual(spec.operations[0].ws, { toServer: ['Greeting'], fromServer: ['Answer'] });
  const r = (await api().post(`/admin/api/tester/specs/${id}/send`).send({ opId: '/echo' }).expect(200)).body;
  assert.equal(r.outcome, 'fail');
  const m = r.checks.find((c) => c.name === 'message[1]');
  assert.equal(m.status, 'fail');
  assert.match(JSON.stringify(m.errors), /answer/);
});
