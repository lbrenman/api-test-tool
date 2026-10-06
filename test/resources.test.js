'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

let t;
before(async () => { t = await makeApp(); });
after(async () => { await t.close(); });

test('health reports ok with checks', async () => {
  const r = await request(t.app).get('/health').expect(200);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.checks.database.ok, true);
  assert.equal(r.body.checks.fileStore.ok, true);
  assert.equal(r.body.data.employees, 40);
  assert.ok(!JSON.stringify(r.body).includes('demo-secret'));
});

test('employees list uses offset pagination and rich types', async () => {
  const r = await request(t.app).get('/v1/employees?limit=5').expect(200);
  assert.equal(r.body.data.length, 5);
  assert.deepEqual(Object.keys(r.body.meta).sort(), ['limit', 'offset', 'total']);
  const e = r.body.data[0];
  assert.equal(typeof e.id, 'number');
  assert.match(e.uuid, /^[0-9a-f-]{36}$/);
  assert.match(e.employeeNumber, /^EMP-\d{6}$/);
  assert.equal(typeof e.salary, 'number');
  assert.match(e.salaryDecimal, /^\d+\.\d{2}$/);
  assert.equal(typeof e.isActive, 'boolean');
  assert.ok(Array.isArray(e.skills));
  assert.ok(Array.isArray(e.phoneNumbers));
  assert.equal(typeof e.department, 'object');
  assert.equal(e.department.id, e.departmentId);
  assert.match(e.hireDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(e.createdAt, /Z$/);
  assert.ok(r.get('X-Request-Id'));
});

test('products include unicode descriptions and nested category', async () => {
  const r = await request(t.app).get('/v1/products?limit=20').expect(200);
  assert.ok(r.body.data.some((p) => /[^\x00-\x7f]/.test(p.description)));
  assert.equal(r.body.data[0].category.id, r.body.data[0].categoryId);
});

test('POST creates with 201, Location and ETag; GET supports If-None-Match', async () => {
  const body = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', departmentId: 1, salary: 123456.7 };
  const c = await request(t.app).post('/v1/employees').send(body).expect(201);
  assert.match(c.get('Location'), /\/v1\/employees\/\d+$/);
  assert.ok(c.get('ETag'));
  assert.equal(c.body.salaryDecimal, '123456.70');
  const id = c.body.id;
  const g = await request(t.app).get(`/v1/employees/${id}`).expect(200);
  assert.equal(g.body.firstName, 'Ada');
  await request(t.app).get(`/v1/employees/${id}`).set('If-None-Match', g.get('ETag')).expect(304);
});

test('PUT/PATCH honour If-Match (412 on mismatch) and merge patch semantics', async () => {
  const c = await request(t.app).post('/v1/employees').send({ firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com', departmentId: 2, performanceRating: 4.5 }).expect(201);
  const id = c.body.id;
  await request(t.app).patch(`/v1/employees/${id}`).set('If-Match', '"nope"').set('Content-Type', 'application/merge-patch+json').send(JSON.stringify({ title: 'x' })).expect(412);
  const p = await request(t.app).patch(`/v1/employees/${id}`).set('If-Match', c.get('ETag'))
    .set('Content-Type', 'application/merge-patch+json').send(JSON.stringify({ title: 'Rear Admiral', performanceRating: null, address: { city: 'Arlington' } })).expect(200);
  assert.equal(p.body.title, 'Rear Admiral');
  assert.equal(p.body.performanceRating, null);
  assert.equal(p.body.address.city, 'Arlington');
  assert.equal(p.body.firstName, 'Grace');
  const put = await request(t.app).put(`/v1/employees/${id}`).send({ firstName: 'G', lastName: 'H', email: 'gh@example.com', departmentId: 3 }).expect(200);
  assert.equal(put.body.title, '');
  assert.equal(put.body.departmentId, 3);
  await request(t.app).delete(`/v1/employees/${id}`).set('If-Match', '"stale"').expect(412);
  await request(t.app).delete(`/v1/employees/${id}`).expect(204);
  const nf = await request(t.app).get(`/v1/employees/${id}`).expect(404);
  assert.match(nf.get('Content-Type'), /application\/problem\+json/);
  assert.equal(nf.body.status, 404);
  assert.ok(nf.body.requestId);
});

test('validation returns 422 with field errors; malformed JSON 400; wrong type 415', async () => {
  const v = await request(t.app).post('/v1/employees').send({ firstName: 'X', email: 'not-an-email', departmentId: 9999, bogus: 1 }).expect(422);
  const fields = v.body.errors.map((e) => e.field);
  assert.ok(fields.includes('lastName'));
  assert.ok(fields.includes('email'));
  assert.ok(fields.includes('bogus'));
  const ref = await request(t.app).post('/v1/employees').send({ firstName: 'X', lastName: 'Y', email: 'x@example.com', departmentId: 9999 }).expect(422);
  assert.equal(ref.body.errors[0].field, 'departmentId');
  await request(t.app).post('/v1/employees').set('Content-Type', 'application/json').send('{"broken":').expect(400);
  await request(t.app).post('/v1/employees').set('Content-Type', 'text/plain').send('hello').expect(415);
});

test('Idempotency-Key replays the original response and rejects a different body', async () => {
  const key = `k-${Date.now()}`;
  const body = { name: 'Quantum', code: 'QNT' };
  const a = await request(t.app).post('/v1/departments').set('Idempotency-Key', key).send(body).expect(201);
  const b = await request(t.app).post('/v1/departments').set('Idempotency-Key', key).send(body).expect(201);
  assert.equal(b.get('Idempotent-Replayed'), 'true');
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.get('Location'), a.get('Location'));
  await request(t.app).post('/v1/departments').set('Idempotency-Key', key).send({ name: 'Other', code: 'OTH' }).expect(409);
});

test('fields, filters, operators, text search and sort', async () => {
  const f = await request(t.app).get('/v1/employees?fields=id,firstName,department.name&limit=3').expect(200);
  assert.deepEqual(Object.keys(f.body.data[0]).sort(), ['department', 'firstName', 'id']);
  assert.deepEqual(Object.keys(f.body.data[0].department), ['name']);
  const p = await request(t.app).get('/v1/products?price[gte]=100&price[lt]=500&sort=-price&limit=200').expect(200);
  assert.ok(p.body.data.every((x) => x.price >= 100 && x.price < 500));
  for (let i = 1; i < p.body.data.length; i++) assert.ok(p.body.data[i - 1].price >= p.body.data[i].price);
  const b = await request(t.app).get('/v1/products?inStock=false&limit=200').expect(200);
  assert.ok(b.body.data.every((x) => x.inStock === false));
  const lvl = await request(t.app).get('/v1/employees?level=L1,L2&limit=200').expect(200);
  assert.ok(lvl.body.data.every((x) => ['L1', 'L2'].includes(x.level)));
  const someName = (await request(t.app).get('/v1/employees?limit=1')).body.data[0].lastName;
  const q = await request(t.app).get(`/v1/employees?q=${encodeURIComponent(someName)}`).expect(200);
  assert.ok(q.body.data.length >= 1);
  await request(t.app).get('/v1/employees?colour=blue').expect(400);
  await request(t.app).get('/v1/employees?sort=nope').expect(400);
});

test('nested collections and referential delete protection', async () => {
  const n = await request(t.app).get('/v1/departments/1/employees?limit=200').expect(200);
  assert.ok(n.body.data.every((e) => e.departmentId === 1));
  await request(t.app).get('/v1/departments/999/employees').expect(404);
  const used = (await request(t.app).get('/v1/employees?limit=1')).body.data[0].departmentId;
  await request(t.app).delete(`/v1/departments/${used}`).expect(409);
  await request(t.app).get('/v1/nothing-here').expect(404);
});
