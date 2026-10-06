'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { listen } = require('./helpers');

const SAMPLE = fs.readFileSync(path.join(__dirname, '../samples/Supplier_Order_Collaboration_OpenAPI_3_1.yaml'), 'utf8');

let t;
before(async () => { t = await listen({ SEED_EMPLOYEES: '15', SEED_PRODUCTS: '15' }); });
after(async () => { await t.stop(); });

const api = (m, p) => request(t.app)[m](`/admin/api/tester${p}`);

test('loads the sample spec (paste), lints the allOf trap without crashing', async () => {
  const c = await api('post', '/specs').send({ content: SAMPLE }).expect(201);
  assert.equal(c.body.version, '3.1');
  assert.ok(c.body.lint.error >= 1);
  const lint = (await api('get', `/specs/${c.body.id}/lint`).expect(200)).body;
  const trap = lint.issues.find((i) => i.rule === 'allof-additional-properties');
  assert.ok(trap, 'allOf trap flagged');
  assert.match(trap.message, /Shipment/);
  assert.match(trap.message, /CreateShipmentRequest/);
  assert.match(trap.fix, /unevaluatedProperties/);
  assert.ok(lint.issues.some((i) => i.rule === 'placeholder-server'));
  assert.ok(lint.issues.some((i) => i.rule === 'placeholder-token-url'));
  assert.ok(lint.issues.some((i) => i.rule === 'invalid-example' && /createAdvanceShipmentNotice|shipments/.test(i.message)));
});

test('sample generation honours patterns and required headers', async () => {
  const c = (await api('post', '/specs').send({ sample: 'Supplier_Order_Collaboration_OpenAPI_3_1.yaml' }).expect(201)).body;
  const ops = (await api('get', `/specs/${c.id}/operations`).expect(200)).body;
  assert.equal(ops.length, 6);
  const get = (await api('get', `/specs/${c.id}/request?op=${encodeURIComponent('GET /shipments/{shipmentId}')}`).expect(200)).body;
  const sid = get.params.find((p) => p.name === 'shipmentId').value;
  assert.match(sid, /^SHP-[0-9]{8}-[0-9]{5}$/);
  const post = (await api('get', `/specs/${c.id}/request?op=createAdvanceShipmentNotice`).expect(200)).body;
  assert.equal(post.params.find((p) => p.name === 'Idempotency-Key').value, '{{uuid}}');
  assert.equal(post.body.shipmentNoticeNumber, 'ASN-440882');
  const listPo = (await api('get', `/specs/${c.id}/request?op=listPurchaseOrders`).expect(200)).body;
  assert.ok(listPo.params.find((p) => p.name === 'status').value.length > 0);
});

test('URL and Swagger 2.0 loading', async () => {
  const u = await api('post', '/specs').send({ url: `${t.url}/samples/Supplier_Order_Collaboration_OpenAPI_3_1.yaml` }).expect(201);
  assert.equal(u.body.version, '3.1');
  const s2 = await api('post', '/specs').send({ sample: 'Inventory_Swagger_2_0.yaml' }).expect(201);
  assert.equal(s2.body.originalVersion, '2.0');
  assert.equal(s2.body.version, '3.0');
  await api('post', '/specs').send({ content: 'not: [valid' }).expect(422);
  await api('post', '/specs').send({ content: 'openapi: 9.9.9\npaths: {}' }).expect(422);
});

test('mock from spec + run all: strict validation fails Shipment, lenient allOf passes it', async () => {
  const c = (await api('post', '/specs').send({ sample: 'Supplier_Order_Collaboration_OpenAPI_3_1.yaml', name: 'Supplier Mock Test' }).expect(201)).body;
  const m = await api('post', `/specs/${c.id}/mock`).send({ useAsTarget: true }).expect(201);
  assert.ok(m.body.count >= 6);
  assert.match(m.body.url, /\/mock\/supplier-mock-test$/);

  const strict = (await api('post', `/specs/${c.id}/runs`).send({}).expect(201)).body;
  const ship = strict.steps.find((s) => s.opId === 'POST /shipments');
  assert.equal(ship.response.status, 201);
  assert.ok(ship.response.headers.location, 'Location header served by the mock');
  const schemaCheck = ship.checks.find((x) => x.name === 'body-schema');
  assert.equal(schemaCheck.status, 'fail');
  assert.ok(schemaCheck.errors.some((e) => /additionalProperties/.test(e.message)));
  const po = strict.steps.find((s) => s.opId === 'GET /purchase-orders/{purchaseOrderId}');
  assert.equal(po.outcome, 'pass');

  const lenient = (await api('post', `/specs/${c.id}/runs`).send({ lenientAllOf: true }).expect(201)).body;
  const ship2 = lenient.steps.find((s) => s.opId === 'POST /shipments');
  assert.equal(ship2.checks.find((x) => x.name === 'body-schema').status, 'pass');
  assert.ok(lenient.summary.failed < strict.summary.failed);

  // history, reports
  const runs = (await api('get', `/specs/${c.id}/runs`).expect(200)).body;
  assert.equal(runs.length, 2);
  const html = await api('get', `/runs/${runs[0].id}/report.html`).expect(200);
  assert.match(html.text, /<!doctype html>/i);
  const json = await api('get', `/runs/${runs[0].id}/export.json`).expect(200);
  assert.equal(json.body.id, runs[0].id);
  await api('delete', `/specs/${c.id}/mock`).expect(200);
});

test('contract run against this tool\'s own live spec passes, with negative tests and id chaining', async () => {
  await t.ctx.settings.setMany({ authMode: 'oauth2' });
  try {
    const c = (await api('post', '/specs').send({ sample: 'self' }).expect(201)).body;
    const spec = (await api('get', `/specs/${c.id}`).expect(200)).body;
    const profile = spec.profiles.find((p) => p.type === 'oauth2cc');
    assert.ok(profile);
    await api('put', `/specs/${c.id}`).send({ target: { baseUrl: t.url, auth: { ...profile, clientId: 'demo-client', clientSecret: 'demo-secret', scopes: 'read write' } } }).expect(200);
    const ids = ['POST /v1/departments', 'GET /v1/departments', 'GET /v1/departments/{id}', 'PATCH /v1/departments/{id}', 'GET /v1/p/cursor/employees', 'GET /v1/p/hal/products', 'GET /v1/p/link/employees', 'GET /v1/employees/{id}', 'GET /v1/files/{fileId}'];
    const run = (await api('post', `/specs/${c.id}/runs`).send({ operationIds: ids, negative: true }).expect(201)).body;
    const failed = run.steps.filter((s) => s.outcome === 'fail').map((s) => `${s.kind}:${s.test || ''} ${s.opId} ${JSON.stringify(s.checks.filter((x) => x.status === 'fail'))}`);
    assert.deepEqual(failed, []);
    const created = run.steps.find((s) => s.opId === 'POST /v1/departments' && s.kind === 'positive');
    const got = run.steps.find((s) => s.opId === 'GET /v1/departments/{id}' && s.kind === 'positive');
    assert.equal(new URL(got.request.url).pathname, new URL(created.response.headers.location).pathname, 'id chained from Location');
    assert.ok(run.steps.some((s) => s.test === 'no-auth' && s.outcome === 'pass'));
    assert.ok(run.steps.some((s) => s.test === 'unknown-id' && s.outcome === 'pass'));
    assert.ok(run.steps.some((s) => s.test === 'invalid-body' && s.outcome === 'pass'));
    const tok = run.steps.find((s) => s.tokenExchange);
    assert.ok(tok.tokenExchange.request.url.endsWith('/oauth/token'));
  } finally {
    await t.ctx.settings.set('authMode', 'none');
  }
});

test('single send through the proxy with the full request/response', async () => {
  const c = (await api('post', '/specs').send({ sample: 'self' }).expect(201)).body;
  await api('put', `/specs/${c.id}`).send({ target: { baseUrl: t.url } }).expect(200);
  const r = (await api('post', `/specs/${c.id}/send`).send({ opId: 'GET /v1/employees' }).expect(200)).body;
  assert.equal(r.response.status, 200);
  assert.equal(r.outcome, 'pass');
  assert.ok(r.request.url.startsWith(t.url));
});
