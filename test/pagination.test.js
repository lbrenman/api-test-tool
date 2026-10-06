'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

let t;
let total;
before(async () => {
  t = await makeApp();
  total = (await request(t.app).get('/v1/employees?limit=1')).body.meta.total;
});
after(async () => { await t.close(); });

const pathOf = (url) => { const u = new URL(url); return u.pathname + u.search; };

test('offset', async () => {
  const ids = [];
  for (let offset = 0; offset < total; offset += 7) {
    const r = await request(t.app).get(`/v1/p/offset/employees?offset=${offset}&limit=7`).expect(200);
    ids.push(...r.body.data.map((d) => d.id));
  }
  assert.equal(new Set(ids).size, total);
});

test('page', async () => {
  const first = await request(t.app).get('/v1/p/page/employees?page=1&size=9').expect(200);
  const ids = [];
  for (let p = 1; p <= first.body.meta.totalPages; p++) ids.push(...(await request(t.app).get(`/v1/p/page/employees?page=${p}&size=9`)).body.data.map((d) => d.id));
  assert.equal(new Set(ids).size, total);
  assert.equal(first.body.meta.totalItems, total);
});

test('cursor follows nextCursor to the end and supports prevCursor', async () => {
  let cursor = null;
  const ids = [];
  let last;
  do {
    last = (await request(t.app).get(`/v1/p/cursor/employees?limit=8${cursor ? `&cursor=${cursor}` : ''}`).expect(200)).body;
    ids.push(...last.data.map((d) => d.id));
    cursor = last.nextCursor;
  } while (cursor);
  assert.equal(new Set(ids).size, total);
  assert.ok(last.prevCursor);
  await request(t.app).get('/v1/p/cursor/employees?cursor=garbage!').expect(400);
});

test('keyset after_id / before_id', async () => {
  let after = 0;
  const ids = [];
  let body;
  do {
    body = (await request(t.app).get(`/v1/p/keyset/employees?after_id=${after}&limit=6`).expect(200)).body;
    ids.push(...body.data.map((d) => d.id));
    after = body.lastId;
  } while (body.hasMore);
  assert.equal(new Set(ids).size, total);
  const before = (await request(t.app).get('/v1/p/keyset/employees?before_id=10&limit=3').expect(200)).body;
  assert.deepEqual(before.data.map((d) => d.id), [7, 8, 9]);
});

test('link header (RFC 8288) + X-Total-Count', async () => {
  let next = '/v1/p/link/employees?page=1&per_page=11';
  const ids = [];
  while (next) {
    const r = await request(t.app).get(next).expect(200);
    assert.ok(Array.isArray(r.body));
    assert.equal(Number(r.get('X-Total-Count')), total);
    ids.push(...r.body.map((d) => d.id));
    const m = /<([^>]+)>;\s*rel="next"/.exec(r.get('Link'));
    next = m ? pathOf(m[1]) : null;
  }
  assert.equal(new Set(ids).size, total);
});

test('HAL _embedded/_links', async () => {
  let next = '/v1/p/hal/products?size=13';
  let count = 0;
  while (next) {
    const r = await request(t.app).get(next).expect(200);
    assert.match(r.get('Content-Type'), /application\/hal\+json/);
    count += r.body._embedded.products.length;
    next = r.body._links.next ? pathOf(r.body._links.next.href) : null;
  }
  assert.equal(count, (await request(t.app).get('/v1/products?limit=1')).body.meta.total);
});

test('token (AIP-158 style) with filters preserved', async () => {
  let token = '';
  const ids = [];
  let body;
  do {
    body = (await request(t.app).get(`/v1/p/token/employees?pageSize=5&isActive=true${token ? `&pageToken=${token}` : ''}`).expect(200)).body;
    assert.ok(body.items.every((e) => e.isActive === true));
    ids.push(...body.items.map((d) => d.id));
    token = body.nextPageToken;
  } while (token);
  assert.equal(body.nextPageToken, null);
  assert.ok(ids.length > 0);
});

test('limits are validated', async () => {
  await request(t.app).get('/v1/p/offset/employees?limit=500').expect(400);
  await request(t.app).get('/v1/p/page/employees?page=0').expect(400);
  await request(t.app).get('/v1/p/sideways/employees').expect(404);
});
