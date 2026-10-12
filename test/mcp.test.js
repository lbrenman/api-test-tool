'use strict';
// Mock MCP server (/mcp): 2026-07-28 stateless requests (header checks, discover, tools, resources, prompts,
// progress streaming, subscriptions/listen), legacy sessions (initialize, GET stream, DELETE), the shared stack
// (auth incl. protected resource metadata and scopes, chaos), MCP chaos and the RFC 8707 resource indicator.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { listen } = require('./helpers');
const { apiKind } = require('../src/middleware/inspector');

let t;
before(async () => { t = await listen({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.stop(); });

const api = () => request(t.app);
const set = (k, v) => t.ctx.settings.set(k, v);
const reset = async (keys) => { for (const key of keys) await t.ctx.settings.reset({ key }); };
const M = 'io.modelcontextprotocol/';
const V = '2026-07-28';
const META = { [`${M}protocolVersion`]: V, [`${M}clientCapabilities`]: {}, [`${M}clientInfo`]: { name: 'test', version: '1' } };
let nextId = 1;

// A well-formed 2026-07-28 request; `headers` adds or overrides (null removes).
function modern(method, params = {}, headers = {}) {
  const name = params.name ?? params.uri;
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': V, 'Mcp-Method': method, ...(name !== undefined ? { 'Mcp-Name': name } : {}), ...headers };
  let r = api().post('/mcp');
  for (const [k, v] of Object.entries(h)) if (v !== null) r = r.set(k, v);
  return r.send({ jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: { ...META, ...(params._meta || {}) } } });
}
const call = (name, args, headers) => modern('tools/call', { name, arguments: args }, headers);

function legacyPost(sid, body, version = '2025-11-25') {
  let r = api().post('/mcp').set('Accept', 'application/json, text/event-stream');
  if (sid) r = r.set('Mcp-Session-Id', sid);
  if (sid && version !== '2025-03-26') r = r.set('MCP-Protocol-Version', version);
  return r.send(body);
}
async function initialize(version = '2025-11-25') {
  const r = await legacyPost(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } }).expect(200);
  const sid = r.get('Mcp-Session-Id');
  assert.ok(sid);
  await legacyPost(sid, { jsonrpc: '2.0', method: 'notifications/initialized' }, r.body.result.protocolVersion).expect(202);
  return { sid, result: r.body.result };
}

// Reads an SSE response until `until(messages)` or the end; returns { status, headers, messages, close }.
function stream(body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${t.url}/mcp`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      const s = { status: res.statusCode, headers: res.headers, messages: [], text: '', ended: false };
      const waiters = [];
      res.setEncoding('utf8');
      res.on('data', (c) => {
        s.text += c;
        s.messages = s.text.split('\n\n').map((b) => b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d));
        waiters.splice(0).forEach((f) => f());
      });
      const fin = () => { s.ended = true; waiters.splice(0).forEach((f) => f()); };
      res.on('end', fin); res.on('close', fin); res.on('error', fin);
      s.until = (pred, ms = 4000) => new Promise((ok, no) => {
        const tm = setTimeout(() => no(new Error(`timed out; got ${s.text.slice(-300)}`)), ms);
        const check = () => { if (pred(s.messages)) { clearTimeout(tm); ok(s); } else if (s.ended) { clearTimeout(tm); no(new Error(`ended; got ${s.text.slice(-300)}`)); } else waiters.push(check); };
        check();
      });
      s.close = () => req.destroy();
      resolve(s);
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('server/discover, tools/list and the inspector source (2026-07-28)', async () => {
  const d = (await modern('server/discover').expect(200)).body;
  assert.equal(d.jsonrpc, '2.0');
  assert.equal(d.result.resultType, 'complete');
  assert.deepEqual(d.result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
  assert.ok(d.result.capabilities.tools && d.result.capabilities.resources.subscribe);
  assert.equal(d.result._meta[`${M}serverInfo`].name, 'api-test-tool-mcp');
  assert.equal(d.result.cacheScope, 'public');
  assert.ok(d.result.ttlMs > 0);

  const l = (await modern('tools/list').expect(200)).body.result;
  const names = l.tools.map((x) => x.name);
  assert.equal(names.length, 22);
  assert.deepEqual(names, (await modern('tools/list')).body.result.tools.map((x) => x.name), 'deterministic order');
  const se = l.tools.find((x) => x.name === 'search_employees');
  assert.equal(se.inputSchema.properties.department['x-mcp-header'], 'Department');
  assert.ok(se.outputSchema && se.annotations.readOnlyHint);
  assert.equal(l.tools.find((x) => x.name === 'delete_employee').annotations.destructiveHint, true);
  assert.ok(l.ttlMs >= 0 && l.cacheScope);
  assert.equal(apiKind('/mcp'), 'mcp');
  const health = (await api().get('/health').expect(200)).body.settings.mcp;
  assert.ok(health.endpoint.endsWith('/mcp'));
  assert.ok(health.protocolVersions.includes(V));
});

test('2026-07-28 header validation: missing or mismatched headers, unsupported versions, Accept', async () => {
  const code = (r) => r.body.error?.code;
  assert.equal(code(await modern('tools/list', {}, { 'Mcp-Method': null }).expect(400)), -32020);
  assert.equal(code(await modern('tools/list', {}, { 'Mcp-Method': 'prompts/list' }).expect(400)), -32020);
  assert.equal(code(await modern('tools/list', {}, { 'MCP-Protocol-Version': '2025-11-25' }).expect(400)), -32020);
  assert.equal(code(await modern('tools/list', {}, { 'MCP-Protocol-Version': null }).expect(400)), -32020);
  assert.equal(code(await call('echo', { message: 'x' }, { 'Mcp-Name': null }).expect(400)), -32020);
  assert.equal(code(await call('echo', { message: 'x' }, { 'Mcp-Name': 'get_stats' }).expect(400)), -32020);
  // Base64 sentinel in Mcp-Name is decoded before comparing.
  await call('echo', { message: 'x' }, { 'Mcp-Name': `=?base64?${Buffer.from('echo').toString('base64')}?=` }).expect(200);
  // x-mcp-header: Mcp-Param-Department must accompany a department argument.
  assert.equal(code(await call('search_employees', { department: 'Engineering' }).expect(400)), -32020);
  assert.equal(code(await call('search_employees', { department: 'Engineering' }, { 'Mcp-Param-Department': 'Sales' }).expect(400)), -32020);
  const ok = await call('search_employees', { department: 'Engineering', limit: 2 }, { 'Mcp-Param-Department': 'Engineering' }).expect(200);
  assert.ok(ok.body.result.structuredContent.items.every((e) => /Engineering/.test(e.department)));
  assert.equal(code(await modern('tools/list', {}, { Accept: 'application/json' }).expect(406)), -32600);

  const bad = await api().post('/mcp').set('Accept', 'application/json, text/event-stream').set('MCP-Protocol-Version', '1900-01-01').set('Mcp-Method', 'tools/list')
    .send({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: { ...META, [`${M}protocolVersion`]: '1900-01-01' } } }).expect(400);
  assert.equal(bad.body.error.code, -32022);
  assert.equal(bad.body.error.data.requested, '1900-01-01');
  assert.ok(bad.body.error.data.supported.includes(V));

  const noCaps = await api().post('/mcp').set('Accept', 'application/json, text/event-stream').set('MCP-Protocol-Version', V).set('Mcp-Method', 'tools/list')
    .send({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: { _meta: { [`${M}protocolVersion`]: V } } }).expect(400);
  assert.equal(noCaps.body.error.code, -32602);

  assert.equal(code(await modern('nope/method').expect(404)), -32601);
  assert.equal(code(await modern('ping').expect(404)), -32601);
  await api().post('/mcp').set('MCP-Protocol-Version', V).send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: META } }).expect(202);
  assert.equal(code(await api().post('/mcp').send([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]).expect(400)), -32600);
  await api().get('/mcp').expect(405).expect('Allow', 'POST');
  await api().delete('/mcp').expect(405);

  await set('mcpValidateHeaders', false);
  try {
    await call('search_employees', { department: 'Engineering' }, { 'Mcp-Name': null, 'Mcp-Method': null }).expect(200);
  } finally {
    await reset(['mcpValidateHeaders']);
  }
});

test('tools: structured results, tool errors, argument validation, writes and read-only mode', async () => {
  const emp = (await call('get_employee', { id: 1 }).expect(200)).body.result;
  assert.equal(emp.resultType, 'complete');
  assert.equal(emp.structuredContent.id, 1);
  assert.equal(JSON.parse(emp.content[0].text).id, 1);
  assert.ok(emp.structuredContent.department.name);

  const missing = (await call('get_employee', { id: 999999 }).expect(200)).body.result;
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found/);

  const badArgs = (await call('get_employee', { id: 'abc' }).expect(200)).body.result;
  assert.equal(badArgs.isError, true);
  assert.match(badArgs.content[0].text, /Invalid arguments/);

  assert.equal((await call('no_such_tool', {}).expect(200)).body.error.code, -32602);

  const created = (await call('create_department', { name: 'MCP Lab', code: 'MCPL' }).expect(200)).body.result.structuredContent;
  assert.ok(created.id);
  const invalid = (await call('create_department', { name: 'x', code: 'lower case' }).expect(200)).body.result;
  assert.equal(invalid.isError, true);
  const upd = (await call('update_employee', { id: 1, changes: { title: 'Chief Mock Officer' } }).expect(200)).body.result.structuredContent;
  assert.equal(upd.title, 'Chief Mock Officer');
  assert.equal((await api().get('/v1/employees/1').expect(200)).body.title, 'Chief Mock Officer', 'the same data as /v1');

  const stats = (await call('get_stats', {}).expect(200)).body.result.structuredContent;
  assert.ok(stats.employees > 0 && stats.headcountByDepartment.length > 0);
  assert.equal((await call('echo', { message: 'hi' }).expect(200)).body.result.structuredContent.message, 'hi');
  assert.equal((await call('simulate_error', { kind: 'protocol' }).expect(200)).body.error.code, -32603);
  assert.equal((await call('simulate_error', { kind: 'tool' }).expect(200)).body.result.isError, true);

  await set('mcpAllowWrites', false);
  try {
    const names = (await modern('tools/list').expect(200)).body.result.tools.map((x) => x.name);
    assert.ok(!names.some((n) => /^(create|update|delete)_/.test(n)));
    assert.equal((await call('delete_employee', { id: 2 }).expect(200)).body.error.code, -32602);
  } finally {
    await reset(['mcpAllowWrites']);
  }
});

test('resources, templates, prompts and completions', async () => {
  const list = (await modern('resources/list').expect(200)).body.result;
  assert.ok(list.resources.some((r) => r.uri === 'att://stats'));
  assert.ok(list.resources.length <= 50);
  assert.equal(list.cacheScope, 'private');
  const tpl = (await modern('resources/templates/list').expect(200)).body.result.resourceTemplates.map((x) => x.uriTemplate);
  assert.ok(tpl.includes('att://employees/{id}'));
  const read = (await modern('resources/read', { uri: 'att://employees/3' }).expect(200)).body.result;
  assert.equal(read.contents[0].mimeType, 'application/json');
  assert.equal(JSON.parse(read.contents[0].text).id, 3);
  assert.equal((await modern('resources/read', { uri: 'att://employees/999999' }).expect(200)).body.error.code, -32602);
  assert.equal((await modern('resources/read', { uri: 'nope://x' }).expect(200)).body.error.code, -32602);

  const prompts = (await modern('prompts/list').expect(200)).body.result.prompts.map((p) => p.name);
  assert.deepEqual(prompts, ['summarize_department', 'draft_welcome_email', 'compare_products']);
  const p = (await modern('prompts/get', { name: 'compare_products', arguments: { productIds: '1,2' } }).expect(200)).body.result;
  assert.equal(p.messages.length, 3);
  assert.equal(p.messages[1].content.type, 'resource');
  assert.equal((await modern('prompts/get', { name: 'summarize_department', arguments: {} }).expect(200)).body.error.code, -32602);
  const c = (await modern('completion/complete', { ref: { type: 'ref/prompt', name: 'summarize_department' }, argument: { name: 'departmentId', value: '1' } }).expect(200)).body.result;
  assert.ok(c.completion.values.every((v) => v.startsWith('1')));
});

test('streamed responses: progress notifications, log messages, response mode', async () => {
  const s = await stream(
    { jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'long_running_task', arguments: { seconds: 1, steps: 3 }, _meta: { ...META, progressToken: 'tok', [`${M}logLevel`]: 'info' } } },
    { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'long_running_task' },
  );
  assert.match(s.headers['content-type'], /text\/event-stream/);
  await s.until((m) => m.some((x) => x.id === 77));
  const progress = s.messages.filter((x) => x.method === 'notifications/progress');
  assert.deepEqual(progress.map((x) => x.params.progress), [1, 2, 3]);
  assert.equal(progress[0].params.progressToken, 'tok');
  assert.ok(s.messages.some((x) => x.method === 'notifications/message'));
  assert.equal(s.messages[s.messages.length - 1].result.structuredContent.done, true);

  await set('mcpResponseMode', 'sse');
  try {
    const r = await modern('tools/list').buffer(true).parse((res, cb) => { let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => cb(null, d)); }).expect(200);
    assert.match(r.get('Content-Type'), /text\/event-stream/);
    assert.match(r.body, /"tools":/);
  } finally {
    await reset(['mcpResponseMode']);
  }
});

test('subscriptions/listen: acknowledgement, resource updates and tool-list changes', async () => {
  const s = await stream(
    { jsonrpc: '2.0', id: 'sub-1', method: 'subscriptions/listen', params: { _meta: META, notifications: { toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: ['att://employees/4'] } } },
    { 'MCP-Protocol-Version': V, 'Mcp-Method': 'subscriptions/listen' },
  );
  try {
    await s.until((m) => m.length >= 1);
    const ack = s.messages[0];
    assert.equal(ack.method, 'notifications/subscriptions/acknowledged');
    assert.equal(ack.params._meta[`${M}subscriptionId`], 'sub-1');
    assert.deepEqual(ack.params.notifications, { toolsListChanged: true, resourceSubscriptions: ['att://employees/4'] });

    await api().patch('/v1/employees/4').send({ title: 'Updated by REST' }).expect(200);
    await s.until((m) => m.some((x) => x.method === 'notifications/resources/updated'));
    const upd = s.messages.find((x) => x.method === 'notifications/resources/updated');
    assert.equal(upd.params.uri, 'att://employees/4');
    assert.equal(upd.params._meta[`${M}subscriptionId`], 'sub-1');

    await api().patch('/v1/employees/5').send({ title: 'Not subscribed' }).expect(200);
    await set('mcpAllowWrites', false);
    await s.until((m) => m.some((x) => x.method === 'notifications/tools/list_changed'));
    assert.ok(!s.messages.some((x) => x.params?.uri === 'att://employees/5'));
  } finally {
    s.close();
    await reset(['mcpAllowWrites']);
  }
});

test('legacy sessions: initialize, version negotiation, session requests, GET stream, DELETE', async () => {
  const { sid, result } = await initialize('2025-06-18');
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.equal(result.serverInfo.name, 'api-test-tool-mcp');
  assert.ok(result.capabilities.tools);

  const tools = (await legacyPost(sid, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '2025-06-18').expect(200)).body.result;
  assert.equal(tools.tools.length, 22);
  assert.equal(tools.resultType, undefined, 'no 2026-07-28 fields in a legacy session');
  assert.deepEqual((await legacyPost(sid, { jsonrpc: '2.0', id: 3, method: 'ping' }, '2025-06-18').expect(200)).body.result, {});
  const r = (await legacyPost(sid, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_product', arguments: { id: 1 } } }, '2025-06-18').expect(200)).body.result;
  assert.equal(r.structuredContent.id, 1);
  assert.equal((await legacyPost(sid, { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'att://products/999999' } }, '2025-06-18').expect(200)).body.error.code, -32002);
  await legacyPost(sid, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, '2025-11-25').expect(400); // version header mismatch

  // An unknown requested version negotiates to the newest legacy version.
  assert.equal((await initialize('2024-01-01')).result.protocolVersion, '2025-11-25');
  // 2025-03-26 clients send no MCP-Protocol-Version header.
  const old = await initialize('2025-03-26');
  await legacyPost(old.sid, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, '2025-03-26').expect(200);

  // GET stream + resources/subscribe.
  await legacyPost(sid, { jsonrpc: '2.0', id: 8, method: 'resources/subscribe', params: { uri: 'att://products/2' } }, '2025-06-18').expect(200);
  const s = await stream(null, { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '2025-06-18' });
  try {
    assert.match(s.headers['content-type'], /text\/event-stream/);
    await new Promise((ok) => setTimeout(ok, 50));
    await api().patch('/v1/products/2').send({ name: 'Renamed for MCP' }).expect(200);
    await s.until((m) => m.some((x) => x.method === 'notifications/resources/updated' && x.params.uri === 'att://products/2'));
  } finally {
    s.close();
  }

  await api().delete('/mcp').set('Mcp-Session-Id', sid).expect(204);
  assert.equal((await legacyPost(sid, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, '2025-06-18').expect(404)).body.error.code, -32001);
  assert.equal((await legacyPost(null, { jsonrpc: '2.0', id: 10, method: 'tools/list' }).expect(400)).body.error.code, -32600);

  await set('mcpLegacy', false);
  try {
    const e = (await legacyPost(null, { jsonrpc: '2.0', id: 11, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }).expect(400)).body.error;
    assert.equal(e.code, -32022);
    assert.deepEqual(e.data.supported, ['2026-07-28']);
  } finally {
    await reset(['mcpLegacy']);
  }
});

test('auth: JSON-RPC 401 with resource_metadata, protected resource metadata, scopes, RFC 8707 audience', async () => {
  const prm = (await api().get('/.well-known/oauth-protected-resource/mcp').expect(200)).body;
  assert.equal(prm.resource, `${t.url}/mcp`);
  assert.deepEqual(prm.authorization_servers, [t.url]);
  await api().get('/.well-known/oauth-protected-resource').expect(200);

  await set('authMode', 'oauth2');
  try {
    const r = await modern('tools/list').expect(401);
    assert.equal(r.body.jsonrpc, '2.0');
    assert.equal(r.body.error.code, -32001);
    assert.match(r.get('WWW-Authenticate'), /^Bearer .*resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);

    const token = async (scope, resource) => {
      const form = { grant_type: 'client_credentials', scope, ...(resource ? { resource } : {}) };
      return (await api().post('/oauth/token').auth('demo-client', 'demo-secret').type('form').send(form).expect(200)).body.access_token;
    };
    const readOnly = await token('read', `${t.url}/mcp`);
    const claims = JSON.parse(Buffer.from(readOnly.split('.')[1], 'base64url').toString());
    assert.ok(Array.isArray(claims.aud) && claims.aud.includes(`${t.url}/mcp`), 'resource indicator in the audience');
    await modern('tools/list', {}, { Authorization: `Bearer ${readOnly}` }).expect(200);
    await call('get_employee', { id: 1 }, { Authorization: `Bearer ${readOnly}` }).expect(200);
    const denied = await call('create_department', { name: 'Nope', code: 'NOPE' }, { Authorization: `Bearer ${readOnly}` }).expect(403);
    assert.equal(denied.body.error.code, -32003);
    await call('create_department', { name: 'Scoped', code: 'SCOPED' }, { Authorization: `Bearer ${await token('read write')}` }).expect(200);
    const badResource = await api().post('/oauth/token').auth('demo-client', 'demo-secret').type('form').send({ grant_type: 'client_credentials', resource: 'https://elsewhere.example/mcp' }).expect(400);
    assert.equal(badResource.body.error, 'invalid_target');
  } finally {
    await reset(['authMode']);
  }
});

test('chaos: X-Force-MCP-Error and the shared X-Force-Error', async () => {
  const tool = await call('echo', { message: 'x' }, { 'X-Force-MCP-Error': 'tool' }).expect(200);
  assert.equal(tool.body.result.isError, true);
  assert.equal(tool.get('X-Chaos-Injected'), 'mcp-tool');
  assert.equal((await modern('tools/list', {}, { 'X-Force-MCP-Error': 'rpc:-32050' }).expect(200)).body.error.code, -32050);
  await assert.rejects(modern('tools/list', {}, { 'X-Force-MCP-Error': 'drop' }));
  const e = await modern('tools/list', {}, { 'X-Force-Error': '503' }).expect(503);
  assert.equal(e.body.error.code, -32603);
  assert.equal(e.body.error.data.status, 503);
  const parse = await api().post('/mcp').set('Content-Type', 'application/json').send('{"jsonrpc":').expect(400);
  assert.equal(parse.body.error.code, -32700);

  await set('mcpEnabled', false);
  try {
    await modern('tools/list').expect(404);
    await api().get('/.well-known/oauth-protected-resource/mcp').expect(404);
  } finally {
    await reset(['mcpEnabled']);
  }
});
