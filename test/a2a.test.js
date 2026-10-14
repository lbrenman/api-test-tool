'use strict';
// Mock A2A agent (/a2a): Agent Cards, A2A 1.0 JSON-RPC and HTTP+JSON, 0.3 JSON-RPC, the task lifecycle
// (completed, failed, rejected, input-required, canceled), streaming and SubscribeToTask, ListTasks, push
// notifications, version handling, errors, auth (security schemes, scopes, task visibility) and chaos.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { listen } = require('./helpers');
const { apiKind } = require('../src/middleware/inspector');

let t;
before(async () => { t = await listen({ SEED_SAMPLE_FILES: 'false', A2A_WORK_MS: '60' }); });
after(async () => { await t.stop(); });

const api = () => request(t.app);
const set = (k, v) => t.ctx.settings.set(k, v);
const reset = async (keys) => { for (const key of keys) await t.ctx.settings.reset({ key }); };
let n = 0;
const msg = (text, extra = {}) => ({ messageId: `m-${++n}`, role: 'ROLE_USER', parts: [{ text }], ...extra });
const rpc = (method, params, { version = '1.0', headers = {}, path = '/a2a' } = {}) => {
  let r = api().post(path).set('Content-Type', 'application/json');
  if (version) r = r.set('A2A-Version', version);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send({ jsonrpc: '2.0', id: ++n, method, params });
};
const ask = async (text, opts) => (await rpc('SendMessage', { message: msg(text) }, opts).expect(200)).body.result;
const textOf = (task) => task.artifacts?.find((a) => a.name === 'answer')?.parts[0].text ?? task.status.message?.parts[0].text;

// Reads an SSE response to the end (or until `stop` returns true); returns the parsed data lines.
function sse(path, body, headers = {}, { method = 'POST', stop } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${t.url}${path}`, { method, headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers } }, (res) => {
      let text = '';
      const events = () => text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; if (stop && stop(events())) req.destroy(); });
      const done = () => resolve({ status: res.statusCode, headers: res.headers, events: events() });
      res.on('end', done); res.on('close', done); res.on('error', done);
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('Agent Cards: 1.0 at the well-known URI, 0.3 under /a2a/v0.3, inspector source', async () => {
  const c = (await api().get('/.well-known/agent-card.json').expect(200).expect('Cache-Control', /max-age/)).body;
  assert.equal(c.name, 'API Test Tool data assistant');
  assert.deepEqual(c.supportedInterfaces.map((i) => `${i.protocolBinding} ${i.protocolVersion} ${i.url.replace(t.url, '')}`), ['JSONRPC 1.0 /a2a', 'HTTP+JSON 1.0 /a2a/rest', 'JSONRPC 0.3 /a2a/v0.3']);
  assert.equal(c.capabilities.streaming, true);
  assert.equal(c.capabilities.pushNotifications, true);
  assert.equal(c.capabilities.extendedAgentCard, false);
  assert.deepEqual(c.skills.map((s) => s.id), ['employee-directory', 'product-catalog', 'business-stats', 'data-updates']);
  assert.ok(c.skills.every((s) => s.name && s.description && Array.isArray(s.tags)));
  assert.equal(c.securitySchemes, undefined, 'no security schemes while AUTH_MODE is none');
  assert.deepEqual((await api().get('/a2a/.well-known/agent-card.json').expect(200)).body.supportedInterfaces, c.supportedInterfaces);

  const v03 = (await api().get('/a2a/v0.3/.well-known/agent-card.json').expect(200)).body;
  assert.equal(v03.protocolVersion, '0.3.0');
  assert.equal(v03.url, `${t.url}/a2a/v0.3`);
  assert.equal(v03.preferredTransport, 'JSONRPC');
  assert.equal(apiKind('/a2a'), 'a2a');
  assert.equal(apiKind('/.well-known/agent-card.json'), 'a2a');
  assert.deepEqual((await api().get('/health').expect(200)).body.settings.a2a.versions, ['1.0', '0.3']);
});

test('answers: direct message, completed tasks with artifacts, failed, rejected, data-part operations', async () => {
  const hello = await ask('hello');
  assert.ok(hello.message, 'a greeting is a direct Message');
  assert.equal(hello.message.role, 'ROLE_AGENT');
  assert.match(hello.message.parts[0].text, /Try:/);

  const team = (await ask('Who works in Engineering?')).task;
  assert.equal(team.status.state, 'TASK_STATE_COMPLETED');
  assert.ok(team.id && team.contextId);
  assert.ok(!('createdAt' in team) && !('lastModified' in team), 'no fields outside the 1.0 Task message');
  assert.match(textOf(team), /Found \d+ employee/);
  const data = team.artifacts.find((a) => a.name === 'data');
  assert.equal(data.metadata.operation, 'search_employees');
  assert.ok(data.parts[0].data.items.every((e) => e.department === 'Engineering'));
  assert.equal(team.history[0].role, 'ROLE_USER');

  const emp = (await ask('show employee 3')).task;
  assert.match(textOf(emp), /#3/);
  assert.equal(emp.artifacts.find((a) => a.name === 'data').parts[0].data.id, 3);
  assert.match(textOf((await ask('How many employees do we have?')).task), /employees \(\d+ active\)/);
  const cheap = (await ask('products under $50 that are in stock')).task;
  assert.ok(cheap.artifacts.find((a) => a.name === 'data').parts[0].data.items.every((p) => p.price <= 50 && p.inStock));
  assert.match(textOf((await ask('list departments')).task), /departments:/);

  const missing = (await ask('show employee 999999')).task;
  assert.equal(missing.status.state, 'TASK_STATE_FAILED');
  assert.match(missing.status.message.parts[0].text, /not found/);
  const weather = (await ask('What is the weather in Boston?')).task;
  assert.equal(weather.status.state, 'TASK_STATE_REJECTED');

  const direct = (await rpc('SendMessage', { message: { messageId: 'd1', role: 'ROLE_USER', parts: [{ data: { tool: 'search_products', arguments: { limit: 2 } } }] } }).expect(200)).body.result.task;
  assert.equal(direct.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(direct.artifacts.find((a) => a.name === 'data').parts[0].data.items.length, 2);
});

test('multi-turn: delete asks for confirmation; changes reach the other APIs; read-only mode rejects', async () => {
  const first = (await ask('delete product 4')).task;
  assert.equal(first.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.match(first.status.message.parts[0].text, /Reply yes or no/);
  const done = (await rpc('SendMessage', { message: msg('yes', { taskId: first.id, contextId: first.contextId }) }).expect(200)).body.result.task;
  assert.equal(done.id, first.id);
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
  await api().get('/v1/products/4').expect(404);
  assert.equal((await rpc('SendMessage', { message: msg('more', { taskId: first.id }) }).expect(200)).body.error.code, -32004, 'a finished task takes no more messages');

  const ask2 = (await ask('delete employee')).task;
  assert.equal(ask2.status.state, 'TASK_STATE_INPUT_REQUIRED');
  const confirm = (await rpc('SendMessage', { message: msg('7', { taskId: ask2.id }) }).expect(200)).body.result.task;
  assert.match(confirm.status.message.parts[0].text, /Delete employee 7\?/);
  const no = (await rpc('SendMessage', { message: msg('no', { taskId: ask2.id }) }).expect(200)).body.result.task;
  assert.equal(no.status.state, 'TASK_STATE_REJECTED');
  await api().get('/v1/employees/7').expect(200);

  const upd = (await ask('set employee 5 title to A2A Specialist')).task;
  assert.equal(upd.status.state, 'TASK_STATE_COMPLETED');
  assert.equal((await api().get('/v1/employees/5').expect(200)).body.title, 'A2A Specialist');
  const dep = (await ask('create department Agent Lab code AGL')).task;
  assert.equal(dep.artifacts.find((a) => a.name === 'data').parts[0].data.code, 'AGL');

  await set('a2aAllowWrites', false);
  try {
    assert.equal((await ask('set employee 5 title to Nope')).task.status.state, 'TASK_STATE_REJECTED');
  } finally {
    await reset(['a2aAllowWrites']);
  }
});

test('returnImmediately, GetTask with historyLength, CancelTask, ListTasks with filters and paging', async () => {
  await set('a2aWorkMs', 2000);
  try {
    const started = (await rpc('SendMessage', { message: msg('list categories'), configuration: { returnImmediately: true } }).expect(200)).body.result.task;
    assert.ok(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(started.status.state));
    const got = (await rpc('GetTask', { id: started.id, historyLength: 1 }).expect(200)).body.result;
    assert.equal(got.id, started.id);
    assert.ok(got.history.length <= 1);
    const canceled = (await rpc('CancelTask', { id: started.id }).expect(200)).body.result;
    assert.equal(canceled.status.state, 'TASK_STATE_CANCELED');
    assert.equal((await rpc('CancelTask', { id: started.id }).expect(200)).body.error.code, -32002);
  } finally {
    await reset(['a2aWorkMs']);
  }
  const e = (await rpc('GetTask', { id: 'nope' }).expect(200)).body.error;
  assert.equal(e.code, -32001);
  assert.equal(e.data[0]['@type'], 'type.googleapis.com/google.rpc.ErrorInfo');
  assert.equal(e.data[0].reason, 'TASK_NOT_FOUND');

  const ctxId = 'ctx-list-test';
  for (const q of ['list departments', 'show employee 1', 'show employee 999999']) await rpc('SendMessage', { message: msg(q, { contextId: ctxId }) }).expect(200);
  const all = (await rpc('ListTasks', { contextId: ctxId }).expect(200)).body.result;
  assert.equal(all.totalSize, 3);
  assert.equal(all.nextPageToken, '');
  assert.ok(all.tasks.every((x) => x.artifacts === undefined && (x.history || []).length === 0));
  assert.equal((await rpc('ListTasks', { contextId: ctxId, status: 'TASK_STATE_FAILED' }).expect(200)).body.result.totalSize, 1);
  const p1 = (await rpc('ListTasks', { contextId: ctxId, pageSize: 2, includeArtifacts: true }).expect(200)).body.result;
  assert.equal(p1.tasks.length, 2);
  assert.ok(p1.tasks[0].artifacts);
  const p2 = (await rpc('ListTasks', { contextId: ctxId, pageSize: 2, pageToken: p1.nextPageToken }).expect(200)).body.result;
  assert.equal(p2.tasks.length, 1);
  assert.equal((await rpc('ListTasks', { status: 'DONE' }).expect(200)).body.error.code, -32602);
});

test('streaming: task, WORKING, chunked answer artifact, data artifact, COMPLETED; SubscribeToTask', async () => {
  const s = await sse('/a2a', { jsonrpc: '2.0', id: 'st1', method: 'SendStreamingMessage', params: { message: msg('list departments') } }, { 'A2A-Version': '1.0' });
  assert.match(s.headers['content-type'], /text\/event-stream/);
  const results = s.events.map((e) => { assert.equal(e.id, 'st1'); return e.result; });
  assert.ok(results[0].task);
  assert.equal(results[1].statusUpdate.status.state, 'TASK_STATE_WORKING');
  const answer = results.filter((r) => r.artifactUpdate?.artifact.name === 'answer');
  assert.ok(answer.length >= 2, 'the answer is streamed in chunks');
  assert.equal(answer[0].artifactUpdate.append, false);
  assert.equal(answer[answer.length - 1].artifactUpdate.lastChunk, true);
  assert.ok(results.some((r) => r.artifactUpdate?.artifact.name === 'data'));
  assert.equal(results[results.length - 1].statusUpdate.status.state, 'TASK_STATE_COMPLETED');
  assert.ok(!('kind' in results[1].statusUpdate) && !('final' in results[1].statusUpdate), 'no 0.3 fields in 1.0 events');

  await set('a2aWorkMs', 600);
  try {
    const started = (await rpc('SendMessage', { message: msg('how many employees'), configuration: { returnImmediately: true } }).expect(200)).body.result.task;
    const sub = await sse('/a2a', { jsonrpc: '2.0', id: 'sub', method: 'SubscribeToTask', params: { id: started.id } }, { 'A2A-Version': '1.0' });
    assert.equal(sub.events[0].result.task.id, started.id);
    assert.equal(sub.events[sub.events.length - 1].result.statusUpdate.status.state, 'TASK_STATE_COMPLETED');
    assert.equal((await rpc('SubscribeToTask', { id: started.id }).expect(200)).body.error.code, -32004, 'a finished task cannot be subscribed to');
  } finally {
    await reset(['a2aWorkMs']);
  }
});

test('HTTP+JSON binding: send, stream, get, list, cancel, google.rpc.Status errors, version header', async () => {
  const h = { 'A2A-Version': '1.0', 'Content-Type': 'application/a2a+json' };
  const r = await api().post('/a2a/rest/message:send').set(h).send({ message: msg('show product 2') }).expect(200).expect('Content-Type', /application\/a2a\+json/);
  assert.equal(r.body.task.status.state, 'TASK_STATE_COMPLETED');
  const id = r.body.task.id;
  assert.equal((await api().get(`/a2a/rest/tasks/${id}`).set(h).expect(200)).body.id, id);
  assert.ok((await api().get('/a2a/rest/tasks?pageSize=1').set(h).expect(200)).body.tasks.length === 1);
  const nf = await api().get('/a2a/rest/tasks/nope').set(h).expect(404);
  assert.equal(nf.body.error.status, 'NOT_FOUND');
  assert.equal(nf.body.error.details[0].reason, 'TASK_NOT_FOUND');
  assert.equal((await api().post(`/a2a/rest/tasks/${id}:cancel`).set(h).send({}).expect(400)).body.error.details[0].reason, 'TASK_NOT_CANCELABLE');
  assert.equal((await api().post('/a2a/rest/message:send').set('Content-Type', 'application/json').send({ message: msg('hi') }).expect(400)).body.error.details[0].reason, 'VERSION_NOT_SUPPORTED');
  const bad = await api().post('/a2a/rest/message:send').set(h).send({ message: { messageId: 'x', role: 'ROLE_USER', parts: [] } }).expect(400);
  assert.equal(bad.body.error.details[1].fieldViolations[0].field, 'message.parts');
  const s = await sse('/a2a/rest/message:stream', { message: msg('list categories') }, { 'A2A-Version': '1.0' });
  assert.ok(s.events[0].task);
  assert.equal(s.events[s.events.length - 1].statusUpdate.status.state, 'TASK_STATE_COMPLETED');
  await api().get('/a2a/rest/nothing').set(h).expect(404);
});

test('A2A 0.3: no header or /a2a/v0.3, kind fields, lowercase states, final flag, blocking, push config set/get', async () => {
  const m03 = (text, extra = {}) => ({ kind: 'message', messageId: `o-${++n}`, role: 'user', parts: [{ kind: 'text', text }], ...extra });
  const task = (await rpc('message/send', { message: m03('show employee 2') }, { version: '' }).expect(200)).body.result;
  assert.equal(task.kind, 'task');
  assert.equal(task.status.state, 'completed');
  assert.equal(task.artifacts[0].parts[0].kind, 'text');
  assert.equal(task.artifacts[1].parts[0].kind, 'data');
  assert.equal(task.history[0].role, 'user');
  const reply = (await rpc('message/send', { message: m03('help') }, { path: '/a2a/v0.3', version: '' }).expect(200)).body.result;
  assert.equal(reply.kind, 'message');
  assert.equal(reply.role, 'agent');
  assert.equal((await rpc('tasks/get', { id: task.id }, { version: '0.3' }).expect(200)).body.result.id, task.id);

  const s = await sse('/a2a/v0.3', { jsonrpc: '2.0', id: 'o', method: 'message/stream', params: { message: m03('list departments') } });
  const kinds = s.events.map((e) => e.result.kind);
  assert.equal(kinds[0], 'task');
  assert.ok(kinds.includes('artifact-update'));
  const last = s.events[s.events.length - 1].result;
  assert.equal(last.kind, 'status-update');
  assert.equal(last.status.state, 'completed');
  assert.equal(last.final, true);

  await set('a2aWorkMs', 800);
  try {
    const nb = (await rpc('message/send', { message: m03('list categories'), configuration: { blocking: false } }, { path: '/a2a/v0.3', version: '' }).expect(200)).body.result;
    assert.ok(['submitted', 'working'].includes(nb.status.state));
    const set03 = (await rpc('tasks/pushNotificationConfig/set', { taskId: nb.id, pushNotificationConfig: { url: `${t.url}/hooks/a2a-03`, token: 'tok' } }, { path: '/a2a/v0.3', version: '' }).expect(200)).body.result;
    assert.equal(set03.taskId, nb.id);
    assert.equal(set03.pushNotificationConfig.url, `${t.url}/hooks/a2a-03`);
    const got = (await rpc('tasks/pushNotificationConfig/get', { id: nb.id }, { path: '/a2a/v0.3', version: '' }).expect(200)).body.result;
    assert.equal(got.pushNotificationConfig.token, 'tok');
  } finally {
    await reset(['a2aWorkMs']);
  }

  assert.match((await rpc('SendMessage', { message: msg('hi') }, { version: '' }).expect(200)).body.error.message, /A2A-Version: 1.0/);
  assert.equal((await rpc('message/send', { message: m03('hi') }, { path: '/a2a/v0.3', version: '1.0' }).expect(200)).body.error.code, -32009);
  await set('a2aLegacy', false);
  try {
    assert.equal((await rpc('message/send', { message: m03('hi') }, { version: '' }).expect(200)).body.error.code, -32009);
    await api().get('/a2a/v0.3/.well-known/agent-card.json').expect(404);
    assert.equal((await api().get('/.well-known/agent-card.json')).body.supportedInterfaces.length, 2);
  } finally {
    await reset(['a2aLegacy']);
  }
});

test('push notifications: every event is POSTed with the configured credentials', async () => {
  const sent = (await rpc('SendMessage', { message: msg('show employee 4'), configuration: { taskPushNotificationConfig: { url: `${t.url}/hooks/a2a-push`, token: 'n-token', authentication: { scheme: 'Bearer', credentials: 'push-secret' } } } }).expect(200)).body.result.task;
  let caps = [];
  for (let i = 0; i < 40 && caps.length < 4; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    caps = (await t.ctx.inspector.list(200)).filter((c) => c.path === '/hooks/a2a-push');
  }
  assert.ok(caps.length >= 4, `push deliveries: ${caps.length}`);
  const c = await t.ctx.inspector.get(caps[0].id);
  assert.equal(c.headers.authorization, 'Bearer push-secret');
  assert.equal(c.headers['x-a2a-notification-token'], 'n-token');
  assert.match(c.headers['content-type'], /application\/a2a\+json/);

  const cfg = (await rpc('CreateTaskPushNotificationConfig', { taskId: sent.id, url: `${t.url}/hooks/a2a-2` }).expect(200)).body.result;
  assert.ok(cfg.id && cfg.taskId === sent.id);
  assert.equal((await rpc('ListTaskPushNotificationConfigs', { taskId: sent.id }).expect(200)).body.result.configs.length, 2);
  assert.equal((await rpc('GetTaskPushNotificationConfig', { taskId: sent.id, id: cfg.id }).expect(200)).body.result.url, `${t.url}/hooks/a2a-2`);
  assert.deepEqual((await rpc('DeleteTaskPushNotificationConfig', { taskId: sent.id, id: cfg.id }).expect(200)).body.result, {});
  assert.equal((await rpc('CreateTaskPushNotificationConfig', { taskId: sent.id, url: 'not a url' }).expect(200)).body.error.code, -32602);
});

test('auth: security schemes on the card, scopes, extended card, task visibility', async () => {
  await set('authMode', 'oauth2');
  try {
    const card = (await api().get('/.well-known/agent-card.json').expect(200)).body;
    assert.ok(card.securitySchemes.oauth2.oauth2SecurityScheme.flows.clientCredentials.tokenUrl.endsWith('/oauth/token'));
    assert.equal(card.capabilities.extendedAgentCard, true);
    assert.equal((await api().get('/a2a/v0.3/.well-known/agent-card.json').expect(200)).body.securitySchemes.oauth2.type, 'oauth2');
    const r401 = await rpc('SendMessage', { message: msg('hi') }).expect(401);
    assert.equal(r401.body.jsonrpc, '2.0');
    assert.equal(r401.body.error.code, -32000);

    const token = async (scope, client = ['demo-client', 'demo-secret']) => (await api().post('/oauth/token').auth(...client).type('form').send({ grant_type: 'client_credentials', scope }).expect(200)).body.access_token;
    const read = { Authorization: `Bearer ${await token('read')}` };
    const write = { Authorization: `Bearer ${await token('read write')}` };
    const mine = (await rpc('SendMessage', { message: msg('show employee 1') }, { headers: read }).expect(200)).body.result.task;
    assert.equal(mine.status.state, 'TASK_STATE_COMPLETED');
    await rpc('SendMessage', { message: msg('set employee 1 title to X') }, { headers: read }).expect(403);
    await rpc('SendMessage', { message: msg('set employee 1 title to Scoped') }, { headers: write }).expect(200);

    const ext = (await rpc('GetExtendedAgentCard', {}, { headers: read }).expect(200)).body.result;
    assert.ok(ext.skills.some((s) => s.id === 'direct-operations'));

    // Another client cannot see this client's task (open registration allows client_credentials only when told to).
    await set('oauthRegistrationGrants', 'authorization_code refresh_token client_credentials');
    const reg = (await api().post('/oauth/register').send({ client_name: 'other', grant_types: ['client_credentials'], token_endpoint_auth_method: 'client_secret_basic', scope: 'read write' }).expect(201)).body;
    const other = { Authorization: `Bearer ${await token('read', [reg.client_id, reg.client_secret])}` };
    assert.equal((await rpc('GetTask', { id: mine.id }, { headers: other }).expect(200)).body.error.code, -32001);
  } finally {
    await reset(['authMode', 'oauthRegistrationGrants']);
  }
  assert.equal((await rpc('GetExtendedAgentCard', {}).expect(200)).body.error.code, -32007);
});

test('chaos and errors: X-Force-A2A-Error, X-Force-Error, invalid requests, disabled agent', async () => {
  const state = async (f) => (await rpc('SendMessage', { message: msg('show employee 1') }, { headers: { 'X-Force-A2A-Error': f } }).expect(200)).body.result.task.status.state;
  assert.equal(await state('fail'), 'TASK_STATE_FAILED');
  assert.equal(await state('reject'), 'TASK_STATE_REJECTED');
  assert.equal(await state('auth-required'), 'TASK_STATE_AUTH_REQUIRED');
  assert.equal(await state('input-required'), 'TASK_STATE_INPUT_REQUIRED');
  assert.equal((await rpc('SendMessage', { message: msg('hi') }, { headers: { 'X-Force-A2A-Error': 'rpc:-32050' } }).expect(200)).body.error.code, -32050);
  const dropped = await sse('/a2a', { jsonrpc: '2.0', id: 'd', method: 'SendStreamingMessage', params: { message: msg('list departments') } }, { 'A2A-Version': '1.0', 'X-Force-A2A-Error': 'drop' });
  assert.equal(dropped.events.length, 2);
  const forced = await rpc('SendMessage', { message: msg('hi') }, { headers: { 'X-Force-Error': '503' } }).expect(503);
  assert.equal(forced.body.error.code, -32603);

  assert.equal((await rpc('SendMessage', { message: { messageId: 'x', role: 'ROLE_AGENT', parts: [{ text: 'x' }] } }).expect(200)).body.error.code, -32602);
  assert.equal((await rpc('SendMessage', { message: msg('hi'), configuration: { acceptedOutputModes: ['image/png'] } }).expect(200)).body.error.code, -32005);
  assert.equal((await rpc('NoSuchMethod', {}).expect(200)).body.error.code, -32601);
  assert.equal((await api().post('/a2a').set('A2A-Version', '1.0').send([{}]).expect(400)).body.error.code, -32600);
  assert.equal((await api().post('/a2a').set('Content-Type', 'application/json').send('{"jsonrpc":').expect(400)).body.error.code, -32700);
  await api().get('/a2a').expect(405);

  await set('a2aEnabled', false);
  try {
    await rpc('SendMessage', { message: msg('hi') }).expect(404);
    await api().get('/.well-known/agent-card.json').expect(404);
  } finally {
    await reset(['a2aEnabled']);
  }
});
