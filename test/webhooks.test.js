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
  assert.equal(h.name, 'all data created/updated');
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

test('file webhooks: every upload, download and delete path; validation; no events for failures or samples', async () => {
  // Validation: events must fit the resources; defaults follow the resources.
  const def = await hook({ url: `${rx}/files-default`, resources: ['files'] });
  assert.deepEqual([def.resources, def.events, def.name], [['files'], ['uploaded'], 'files uploaded']);
  await del(def.id);
  await api().post('/admin/api/webhooks').send({ url: `${rx}/x`, resources: ['files'], events: ['created'] }).expect(400);
  await api().post('/admin/api/webhooks').send({ url: `${rx}/x`, resources: ['employees'], events: ['uploaded'] }).expect(400);
  const both = await hook({ url: `${rx}/x`, resources: ['*', 'files'], events: ['created', 'uploaded', 'deleted'] });
  assert.deepEqual(both.resources, ['*', 'files']);
  await del(both.id);

  const fh = await hook({ name: 'Files', url: `${rx}/files`, resources: ['files'], events: ['uploaded', 'downloaded', 'deleted'], secret: 'file-webhook-secret' });
  const dataOnly = await hook({ url: `${rx}/data-only`, resources: ['*'], events: ['created', 'updated', 'deleted'] }); // must not get file events
  take();
  // Download events fire when the server finishes the response, which can land just after the client
  // has it: wait (briefly) for the number of deliveries expected, then settle.
  const ev = async (n = 0) => {
    for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 30));
    await drain();
    return take();
  };

  // Uploads: multipart (two parts), raw, base64, dashboard
  const mp = (await api().post('/v1/files/multipart').attach('a', Buffer.from('hello'), 'a.txt').attach('b', Buffer.from('world!'), 'b.txt').expect(201)).body;
  let calls = (await ev(2)).sort((x, y) => x.body.file.name.localeCompare(y.body.file.name)); // two parts, delivered concurrently
  assert.deepEqual(calls.map((c) => [c.path, c.body.event, c.body.via, c.body.file.name, c.body.file.size]), [['/files', 'files.uploaded', 'multipart', 'a.txt', 5], ['/files', 'files.uploaded', 'multipart', 'b.txt', 6]]);
  const f1 = mp.files[0].id;
  assert.equal(calls[0].body.resourceId, f1);
  assert.equal(calls[0].body.href, `http://localhost/v1/files/${f1}`);
  assert.ok(calls[0].headers['x-webhook-signature'].startsWith('sha256='));
  await api().put('/v1/files/raw/raw.bin').set('Content-Type', 'application/octet-stream').send(Buffer.from([1, 2, 3])).expect(201);
  await api().post('/v1/files/base64').send({ name: 'b64.txt', data: Buffer.from('base64!').toString('base64') }).expect(201);
  await api().post('/admin/api/files/upload').set('Content-Type', 'application/octet-stream').set('X-Filename', 'dash.txt').send(Buffer.from('dashboard')).expect(201);
  assert.deepEqual((await ev()).map((c) => [c.body.via, c.body.file.name]), [['raw', 'raw.bin'], ['base64', 'b64.txt'], ['dashboard', 'dash.txt']]);

  // tus: no event until the last chunk
  const loc = (await api().post('/v1/files/tus').set('Tus-Resumable', '1.0.0').set('Upload-Length', '10').set('Upload-Metadata', `filename ${Buffer.from('tus.txt').toString('base64')}`).expect(201)).headers.location;
  const tusPath = new URL(loc, 'http://x').pathname;
  await api().patch(tusPath).set('Tus-Resumable', '1.0.0').set('Content-Type', 'application/offset+octet-stream').set('Upload-Offset', '0').send(Buffer.from('12345')).expect(204);
  assert.equal((await ev()).length, 0);
  await api().patch(tusPath).set('Tus-Resumable', '1.0.0').set('Content-Type', 'application/offset+octet-stream').set('Upload-Offset', '5').send(Buffer.from('67890')).expect(204);
  assert.deepEqual((await ev()).map((c) => [c.body.via, c.body.file.name, c.body.file.size]), [['tus', 'tus.txt', 10]]);

  // Presigned PUT then GET
  const ps = (await api().post('/v1/files/presign').send({ name: 'pre.txt', method: 'PUT', contentType: 'text/plain' }).expect(201)).body;
  await api().put(new URL(ps.url).pathname).set('Content-Type', 'text/plain').send('presigned upload').expect(200);
  assert.deepEqual((await ev()).map((c) => [c.body.via, c.body.file.name]), [['presigned', 'pre.txt']]);
  const pg = (await api().post('/v1/files/presign').send({ fileId: ps.fileId, method: 'GET' }).expect(201)).body;
  await api().get(new URL(pg.url).pathname).expect(200);

  // Downloads: full, range, chunked, base64, dashboard; HEAD and 304 do not count
  await api().get(`/v1/files/${f1}/download`).expect(200);
  await api().get(`/v1/files/${f1}/download`).set('Range', 'bytes=0-1').expect(206);
  await api().get(`/v1/files/${f1}/chunked`).expect(200);
  await api().get(`/v1/files/${f1}/base64`).expect(200);
  await api().get(`/admin/api/files/${f1}/download`).expect(200);
  const etag = (await api().head(`/v1/files/${f1}/download`).expect(200)).headers.etag;
  await api().get(`/v1/files/${f1}/download`).set('If-None-Match', etag).expect(304);
  calls = await ev(6);
  assert.deepEqual(calls.map((c) => [c.body.event, c.body.via, c.body.status, c.body.bytes]), [
    ['files.downloaded', 'presigned', 200, 16],
    ['files.downloaded', 'download', 200, 5],
    ['files.downloaded', 'download', 206, 2],
    ['files.downloaded', 'chunked', 200, 5],
    ['files.downloaded', 'base64', 200, 5],
    ['files.downloaded', 'dashboard', 200, 5],
  ]);
  assert.equal(calls[2].body.range, 'bytes 0-1/5');

  // Deletes through the API and the dashboard; a missing file fires nothing
  await api().delete(`/v1/files/${f1}`).expect(204);
  await api().delete(`/admin/api/files/${mp.files[1].id}`).expect(204);
  await api().delete('/v1/files/f_missing').expect(404);
  assert.deepEqual((await ev()).map((c) => [c.body.event, c.body.via, c.body.resourceId]), [['files.deleted', 'api', f1], ['files.deleted', 'dashboard', mp.files[1].id]]);

  // Failed uploads and regenerated samples fire nothing
  await api().post('/v1/files/raw').set('Content-Type', 'application/octet-stream').set('X-Filename', 'empty.bin').send(Buffer.alloc(0)).expect(400);
  await api().post('/admin/api/files/regenerate').expect(200);
  assert.equal((await ev()).length, 0);

  // Test deliveries pick a file event for a files-only webhook
  const tst = (await api().post(`/admin/api/webhooks/${fh.id}/test`).send({ type: 'downloaded' }).expect(200)).body;
  assert.deepEqual([tst.event, tst.test, tst.request.body.via, typeof tst.request.body.file.name], ['files.downloaded', true, 'test', 'string']);
  await api().post(`/admin/api/webhooks/${fh.id}/test`).send({ type: 'created' }).expect(400);
  assert.equal((await ev()).filter((c) => c.path === '/data-only').length, 0);
  await del(fh.id);
  await del(dataOnly.id);
});
