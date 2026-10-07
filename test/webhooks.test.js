'use strict';
// Outgoing webhooks: definitions (validation, secrets write-only), deliveries on created/updated/deleted
// from any protocol, payload, signature and custom headers, failures and timeouts, test and resend,
// pausing, the delivery log, and persistence across a restart.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const request = require('supertest');
const { makeApp } = require('./helpers');

let t;
let receiver;
let rx;
const got = [];
before(async () => {
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.push({ path: req.url, headers: req.headers, raw: body, body: body ? JSON.parse(body) : null });
      if (req.url === '/slow') { setTimeout(() => { res.end('late'); }, 1000); return; }
      res.writeHead(req.url === '/fail' ? 500 : 200, { 'Content-Type': 'text/plain' });
      res.end(req.url === '/fail' ? 'nope' : 'thanks');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  rx = `http://127.0.0.1:${receiver.address().port}`;
  t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
});
after(async () => { await t.ctx.webhooks.drain(); await t.close(); receiver.closeAllConnections?.(); await new Promise((r) => receiver.close(r)); });

const api = () => request(t.app);
const drain = () => t.ctx.webhooks.drain();
const take = () => got.splice(0);
const hook = async (body) => (await api().post('/admin/api/webhooks').send(body).expect(201)).body;
const del = (id) => api().delete(`/admin/api/webhooks/${id}`).expect(204);

test('definitions: validation, defaults, write-only secret, PATCH, 404', async () => {
  for (const bad of [{}, { url: 'ftp://x' }, { url: 'not a url' }, { url: `${rx}/a`, resources: ['widgets'] }, { url: `${rx}/a`, events: ['viewed'] },
    { url: `${rx}/a`, events: [] }, { url: `${rx}/a`, headers: { 'X-Webhook-Id': 'x' } }, { url: `${rx}/a`, headers: { 'Bad Name': 'x' } }, { url: `${rx}/a`, enabled: 'yes' }]) {
    const r = await api().post('/admin/api/webhooks').send(bad).expect(400);
    assert.equal(r.body.code, 'invalid-webhook', JSON.stringify(bad));
  }
  const h = await hook({ url: `${rx}/defaults`, secret: 'a-long-enough-secret' });
  assert.deepEqual([h.resources, h.events, h.enabled, h.includeData, h.hasSecret, h.secretHint], [['*'], ['created', 'updated'], true, false, true, '…cret']);
  assert.equal(h.secret, undefined);
  assert.equal(h.name, 'all resources created/updated');
  const p = (await api().patch(`/admin/api/webhooks/${h.id}`).send({ name: 'Renamed', secret: null, events: ['deleted', 'created'] }).expect(200)).body;
  assert.deepEqual([p.name, p.hasSecret, p.events, p.url], ['Renamed', false, ['created', 'deleted'], `${rx}/defaults`]);
  assert.equal((await api().get(`/admin/api/webhooks/${h.id}`).expect(200)).body.name, 'Renamed');
  assert.ok((await api().get('/admin/api/webhooks').expect(200)).body.items.some((x) => x.id === h.id));
  await del(h.id);
  await api().get(`/admin/api/webhooks/${h.id}`).expect(404);
  await api().patch('/admin/api/webhooks/wh_nope').send({}).expect(404);
});

test('deliveries: payload, matching, signature, headers, includeData, any protocol', async () => {
  const emp = await hook({ name: 'Employees', url: `${rx}/emp`, resources: ['employees'], events: ['created', 'updated'], secret: 's3cret-for-tests', headers: { 'X-API-Key': 'k123' } });
  const dep = await hook({ name: 'Departments + data', url: `${rx}/dep`, resources: ['departments'], events: ['created', 'deleted'], includeData: true });
  take();

  const e = (await api().post('/v1/employees').send({ firstName: 'Web', lastName: 'Hook', email: 'web.hook@example.com', departmentId: 1 }).expect(201)).body;
  await api().patch(`/v1/employees/${e.id}`).set('Content-Type', 'application/merge-patch+json').send({ title: 'Receiver' }).expect(200);
  await api().delete(`/v1/employees/${e.id}`).expect(204); // employees hook does not listen to deleted
  await drain();
  let calls = take();
  assert.deepEqual(calls.map((c) => [c.path, c.body.event]), [['/emp', 'employees.created'], ['/emp', 'employees.updated']]);
  const c = calls[0];
  assert.deepEqual(Object.keys(c.body).sort(), ['event', 'href', 'id', 'occurredAt', 'resource', 'resourceId', 'type', 'webhookId']);
  assert.deepEqual([c.body.type, c.body.resource, c.body.resourceId, c.body.webhookId], ['created', 'employees', e.id, emp.id]);
  assert.equal(c.body.href, `http://localhost/v1/employees/${e.id}`);
  assert.equal(c.headers['content-type'], 'application/json');
  assert.equal(c.headers['x-api-key'], 'k123');
  assert.equal(c.headers['x-webhook-event'], 'employees.created');
  assert.equal(c.headers['x-webhook-delivery'], c.body.id);
  const expected = `sha256=${crypto.createHmac('sha256', 's3cret-for-tests').update(`${c.headers['x-webhook-timestamp']}.${c.raw}`).digest('hex')}`;
  assert.equal(c.headers['x-webhook-signature'], expected);

  // Another protocol (GraphQL) triggers the same webhooks; includeData adds the record, never on delete.
  const g = (await api().post('/graphql').send({ query: 'mutation { createDepartment(input: { name: "Hooked", code: "HOOK-1" }) { id } }' }).expect(200)).body;
  const depId = g.data.createDepartment.id;
  await api().delete(`/v1/departments/${depId}`).expect(204);
  await drain();
  calls = take();
  assert.deepEqual(calls.map((x) => [x.path, x.body.event]), [['/dep', 'departments.created'], ['/dep', 'departments.deleted']]);
  assert.equal(calls[0].body.data.code, 'HOOK-1');
  assert.equal(calls[0].headers['x-webhook-signature'], undefined);
  assert.equal(calls[1].body.data, undefined);

  // The log: newest first, filterable, custom header values hidden, lastDelivery on the webhook.
  const log = (await api().get(`/admin/api/webhooks/deliveries?webhookId=${emp.id}`).expect(200)).body.items;
  assert.deepEqual(log.map((d) => d.event), ['employees.updated', 'employees.created']);
  assert.equal(log[0].status, 200);
  assert.equal(log[0].ok, true);
  assert.equal(log[0].request.headers['X-API-Key'], '(set)');
  assert.equal(log[0].response.body, 'thanks');
  assert.equal((await api().get(`/admin/api/webhooks/deliveries/${log[0].id}`).expect(200)).body.id, log[0].id);
  assert.equal((await api().get(`/admin/api/webhooks/${emp.id}`).expect(200)).body.lastDelivery.status, 200);
  await del(emp.id);
  await del(dep.id);
});

test('failures, timeouts, test deliveries, resend, pausing, retention', async () => {
  const fail = await hook({ url: `${rx}/fail`, resources: ['categories'] });
  const slow = await hook({ url: `${rx}/slow`, resources: ['categories'] });
  const dead = await hook({ url: 'http://127.0.0.1:1/unreachable', resources: ['categories'] });
  await t.ctx.settings.set('webhookTimeoutMs', 200);
  try {
    take();
    const cat = (await api().post('/v1/categories').send({ name: 'Hook cat', code: 'HKC-1' }).expect(201)).body;
    await drain();
    const log = (await api().get('/admin/api/webhooks/deliveries?limit=3').expect(200)).body.items;
    const by = Object.fromEntries(log.map((d) => [d.webhookId, d]));
    assert.deepEqual([by[fail.id].status, by[fail.id].ok, by[fail.id].response.body], [500, false, 'nope']);
    assert.equal(by[slow.id].ok, false);
    assert.match(by[slow.id].error, /No response within 200 ms/);
    assert.equal(by[dead.id].status, null);
    assert.ok(by[dead.id].error);

    // Test delivery and resend
    const tst = (await api().post(`/admin/api/webhooks/${fail.id}/test`).send({ type: 'updated' }).expect(200)).body;
    assert.deepEqual([tst.test, tst.event, tst.status], [true, 'categories.updated', 500]);
    await api().post(`/admin/api/webhooks/${fail.id}/test`).send({ type: 'viewed' }).expect(400);
    const again = (await api().post(`/admin/api/webhooks/deliveries/${by[fail.id].id}/redeliver`).expect(200)).body;
    assert.equal(again.redeliveryOf, by[fail.id].id);
    assert.notEqual(again.id, by[fail.id].id);
    assert.equal(again.request.body.resourceId, cat.id);
    await api().post('/admin/api/webhooks/deliveries/dlv_nope/redeliver').expect(404);
    await api().delete(`/v1/categories/${cat.id}`).expect(204);
  } finally { await t.ctx.settings.set('webhookTimeoutMs', 10000); }
  await del(slow.id);
  await del(dead.id);

  // Pausing: one webhook, then all of them.
  await api().patch(`/admin/api/webhooks/${fail.id}`).send({ enabled: false }).expect(200);
  take();
  await api().post('/v1/categories').send({ name: 'Paused 1', code: 'HKC-2' }).expect(201);
  await drain();
  assert.equal(take().length, 0);
  await api().patch(`/admin/api/webhooks/${fail.id}`).send({ enabled: true, url: `${rx}/ok` }).expect(200);
  await t.ctx.settings.set('webhooksEnabled', false);
  try {
    await api().post('/v1/categories').send({ name: 'Paused 2', code: 'HKC-3' }).expect(201);
    await drain();
    assert.equal(take().length, 0);
    assert.equal((await api().get('/admin/api/webhooks').expect(200)).body.enabled, false);
  } finally { await t.ctx.settings.set('webhooksEnabled', true); }

  // Retention keeps the newest deliveries.
  await t.ctx.settings.set('webhookDeliveryRetention', 10);
  try {
    for (let i = 0; i < 12; i++) await api().post(`/admin/api/webhooks/${fail.id}/test`).send({}).expect(200);
    assert.equal((await api().get('/admin/api/webhooks/deliveries?limit=500').expect(200)).body.items.length, 10);
  } finally { await t.ctx.settings.set('webhookDeliveryRetention', 200); }
  await api().delete('/admin/api/webhooks/deliveries').expect(204);
  assert.equal((await api().get('/admin/api/webhooks/deliveries').expect(200)).body.items.length, 0);
  await del(fail.id);
});

test('webhooks survive a restart', async () => {
  const a = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  const h = (await request(a.app).post('/admin/api/webhooks').send({ name: 'Persistent', url: `${rx}/persist`, resources: ['products'], events: ['updated'], secret: 'kept-across-restarts' }).expect(201)).body;
  await a.close();

  const b = await makeApp({ SEED_SAMPLE_FILES: 'false' }, { dir: a.dir });
  try {
    const list = (await request(b.app).get('/admin/api/webhooks').expect(200)).body.items;
    assert.deepEqual(list.map((x) => [x.id, x.name, x.hasSecret]), [[h.id, 'Persistent', true]]);
    take();
    await request(b.app).patch('/v1/products/1').set('Content-Type', 'application/merge-patch+json').send({ stockQty: 3 }).expect(200);
    await b.ctx.webhooks.drain();
    const calls = take();
    assert.deepEqual(calls.map((c) => [c.path, c.body.event, c.body.resourceId]), [['/persist', 'products.updated', 1]]);
    assert.equal(calls[0].headers['x-webhook-signature'], `sha256=${crypto.createHmac('sha256', 'kept-across-restarts').update(`${calls[0].headers['x-webhook-timestamp']}.${calls[0].raw}`).digest('hex')}`);
  } finally { await b.close(); }
});
