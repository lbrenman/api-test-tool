'use strict';
// MCP tool access control (MCP_TOOL_ACL): the demo profile and its three agents, the base scope (a suspended agent
// gets nothing through), per-tool scopes (visible but denied: isError), tool:*, MCP_TOOLS, the on/off switch,
// the decision log and the admin API behind the dashboard's Tool access tab.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { listen } = require('./helpers');

let t;
before(async () => { t = await listen({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.stop(); });

const api = () => request(t.app);
const M = 'io.modelcontextprotocol/';
const V = '2026-07-28';
const META = { [`${M}protocolVersion`]: V, [`${M}clientCapabilities`]: {}, [`${M}clientInfo`]: { name: 'test', version: '1' } };
let nextId = 1;
const EP = '/p/tool-acl/mcp';

function mcp(token, method, params = {}, path = EP) {
  const name = params.name ?? params.uri;
  let r = api().post(path).set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream')
    .set('MCP-Protocol-Version', V).set('Mcp-Method', method);
  if (name !== undefined) r = r.set('Mcp-Name', name);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  return r.send({ jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: META } });
}
const call = (token, name, args = {}, path) => mcp(token, 'tools/call', { name, arguments: args }, path);

let demo;
const secret = (id) => demo.agents.find((a) => a.clientId === id).secret;
async function token(id) {
  const r = await api().post('/oauth/token').auth(id, secret(id)).type('form').send({ grant_type: 'client_credentials' }).expect(200);
  return r.body.access_token;
}

test('the demo is off until it is set up, and the tool stays off by default', async () => {
  assert.equal(t.ctx.settings.get('mcpToolAcl'), false);
  const d = (await api().get('/admin/api/tool-acl').expect(200)).body;
  assert.equal(d.exists, false);
  assert.equal(d.agents.every((a) => !a.exists), true);
});

test('setting up the demo creates the profile and three agents with their grants', async () => {
  demo = (await api().post('/admin/api/tool-acl/demo').send({}).expect(200)).body;
  assert.equal(demo.exists, true);
  assert.equal(demo.enabled, true);
  assert.deepEqual(demo.tools.map((x) => x.name), ['search_employees', 'get_employee', 'search_products', 'update_product']);
  assert.deepEqual(demo.agents.map((a) => a.clientId), ['alice-agent', 'bob-agent', 'carol-agent']);
  assert.ok(demo.agents.every((a) => a.exists && a.secret));
  assert.match(demo.endpoint, /\/p\/tool-acl\/mcp$/);
  const pol = Object.fromEntries(demo.policy.map((p) => [p.tool, p.allowed]));
  assert.deepEqual(pol.get_employee, ['alice-agent']);
  assert.deepEqual(pol.search_employees, ['alice-agent', 'bob-agent']);
  // Running it again keeps the secrets
  const again = (await api().post('/admin/api/tool-acl/demo').send({}).expect(200)).body;
  assert.equal(again.agents[0].secret, demo.agents[0].secret);
});

test('tools/list in the profile offers the 4 demo tools to an agent with mcp:access', async () => {
  const r = await mcp(await token('bob-agent'), 'tools/list').expect(200);
  assert.deepEqual(r.body.result.tools.map((x) => x.name), ['search_employees', 'get_employee', 'search_products', 'update_product']);
});

test('alice (admin) may call every tool', async () => {
  const tok = await token('alice-agent');
  for (const [name, args] of [['search_employees', { limit: 2 }], ['get_employee', { id: 1 }], ['search_products', { limit: 2 }], ['update_product', { id: 1, changes: { stockQty: 7 } }]]) {
    const r = await call(tok, name, args).expect(200);
    assert.notEqual(r.body.result.isError, true, `${name}: ${JSON.stringify(r.body.result.content)}`);
  }
});

test('bob (developer): safe reads allowed, salary and writes denied as tool errors', async () => {
  const tok = await token('bob-agent');
  assert.notEqual((await call(tok, 'search_employees', { limit: 1 }).expect(200)).body.result.isError, true);
  const denied = (await call(tok, 'get_employee', { id: 1 }).expect(200)).body.result;
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /bob-agent may not call get_employee; the token lacks the scope "tool:get_employee"/);
  assert.deepEqual(denied.structuredContent, { error: 'access_denied', tool: 'get_employee', requiredScope: 'tool:get_employee' });
  assert.equal((await call(tok, 'update_product', { id: 1, changes: { stockQty: 9 } }).expect(200)).body.result.isError, true);
  assert.notEqual((await api().get('/v1/products/1').expect(200)).body.stockQty, 9, 'the denied write changed nothing');
});

test('carol (suspended): no mcp:access, so even tools/list is 403 insufficient_scope', async () => {
  const tok = await token('carol-agent');
  const r = await mcp(tok, 'tools/list').expect(403);
  assert.match(r.headers['www-authenticate'], /insufficient_scope.*scope="mcp:access"/);
  assert.equal(r.body.jsonrpc, '2.0');
  assert.match(r.body.error.message, /lacks the scope "mcp:access"/);
  await call(tok, 'search_employees', {}).expect(403);
});

test('no token → 401 from the jwt auth mode before any decision', async () => {
  await mcp(null, 'tools/list').expect(401);
});

test('a tool outside MCP_TOOLS is unknown (-32602), even for alice', async () => {
  const r = await call(await token('alice-agent'), 'delete_employee', { id: 1 }).expect(200);
  assert.equal(r.body.error.code, -32602);
});

test('tool:* grants every tool', async () => {
  await api().patch('/admin/api/oauth/clients/bob-agent').send({ scopes: 'mcp:access tool:*' }).expect(200);
  const r = await call(await token('bob-agent'), 'get_employee', { id: 1 }).expect(200);
  assert.notEqual(r.body.result.isError, true);
  await api().post('/admin/api/tool-acl/demo').send({}).expect(200); // back to the default grants
});

test('the decision log records who, which tool, the decision and why', async () => {
  const before = (await api().get('/admin/api/tool-acl/decisions').expect(200)).body.data;
  const last = before[before.length - 1].seq;
  await call(await token('bob-agent'), 'get_employee', { id: 2 }).set('X-Request-Id', 'acl-test-1').expect(200);
  const d = (await api().get(`/admin/api/tool-acl/decisions?after=${last}`).expect(200)).body.data;
  const e = d.find((x) => x.requestId === 'acl-test-1');
  assert.ok(e, 'recorded');
  assert.equal(e.allowed, false);
  assert.equal(e.tool, 'get_employee');
  assert.equal(e.sub, 'bob-agent');
  assert.equal(e.profile, 'tool-acl');
  assert.equal(e.requiredScope, 'tool:get_employee');
  assert.ok(e.scopes.includes('tool:search_employees'));
  await api().delete('/admin/api/tool-acl/decisions').expect(204);
  assert.equal((await api().get('/admin/api/tool-acl/decisions').expect(200)).body.data.length, 0);
});

test('switched off, the profile serves every agent (a gateway in front does the enforcing)', async () => {
  const off = (await api().patch('/admin/api/tool-acl').send({ enabled: false }).expect(200)).body;
  assert.equal(off.enabled, false);
  assert.notEqual((await call(await token('bob-agent'), 'get_employee', { id: 1 }).expect(200)).body.result.isError, true);
  await mcp(await token('carol-agent'), 'tools/list').expect(200);
  assert.equal((await api().get('/admin/api/tool-acl/decisions').expect(200)).body.data.length, 0, 'nothing recorded when off');
  await api().patch('/admin/api/tool-acl').send({ enabled: true }).expect(200);
  await mcp(await token('carol-agent'), 'tools/list').expect(403);
  await api().patch('/admin/api/tool-acl').send({ enabled: 'yes' }).expect(400);
});

test('the global /mcp is untouched by the demo profile', async () => {
  const r = await mcp(null, 'tools/list', {}, '/mcp').expect(200);
  assert.equal(r.body.result.tools.length, 22);
});

test('with a non-JWT auth mode, tool access control answers 401 and says why', async () => {
  const p = t.ctx.profiles.get('tool-acl');
  await api().patch('/admin/api/profiles/tool-acl').send({ settings: { ...p.settings, authMode: 'none' } }).expect(200);
  const r = await mcp(null, 'tools/list').expect(401);
  assert.match(r.body.error.message, /needs the caller's JWT/);
  await api().patch('/admin/api/profiles/tool-acl').send({ settings: { ...p.settings } }).expect(200);
});

test('protected resource metadata lists the tool scopes when the profile has access control on', async () => {
  const r = await api().get('/.well-known/oauth-protected-resource/p/tool-acl/mcp').expect(200);
  assert.ok(r.body.scopes_supported.includes('mcp:access'));
  assert.ok(r.body.scopes_supported.includes('tool:get_employee'));
  const g = await api().get('/.well-known/oauth-protected-resource/mcp').expect(200);
  assert.deepEqual(g.body.scopes_supported, ['read', 'write']);
});
