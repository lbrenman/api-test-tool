'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp } = require('./helpers');

let t;
before(async () => { t = await makeApp({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.close(); });

test('X-Force-Error with a status returns problem+json and X-Chaos-Injected', async () => {
  const r = await request(t.app).get('/v1/employees/1').set('X-Force-Error', '503').expect(503);
  assert.equal(r.get('X-Chaos-Injected'), '503');
  assert.equal(r.get('Retry-After'), '5');
  assert.equal(r.body.status, 503);
  await request(t.app).get('/v1/employees/1').set('X-Force-Error', '418').expect(418);
  await request(t.app).get('/v1/employees/1').set('X-Force-Error', 'banana').expect(400);
});

test('X-Force-Status overrides the handler status', async () => {
  const r = await request(t.app).get('/v1/employees/1').set('X-Force-Status', '202').expect(202);
  assert.equal(r.body.id, 1);
  await request(t.app).get('/v1/employees/1').set('X-Force-Status', '418').expect(418);
});

test('X-Force-Latency delays the response', async () => {
  const start = Date.now();
  await request(t.app).get('/v1/employees/1').set('X-Force-Latency', '300').expect(200);
  assert.ok(Date.now() - start >= 290);
});

test('body corruption types', async () => {
  const m = await request(t.app).get('/v1/employees/1').set('X-Force-Error', 'malformed-json').buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d)); });
  assert.equal(m.status, 200);
  assert.throws(() => JSON.parse(m.body));
  const w = await request(t.app).get('/v1/employees/1').set('X-Force-Error', 'wrong-content-type');
  assert.match(w.get('Content-Type'), /text\/html/);
  const e = await request(t.app).get('/v1/employees/1').set('X-Force-Error', 'empty-body');
  assert.equal(e.get('Content-Length'), '0');
  await t.ctx.settings.set('chaosSlowDripMs', 10);
  const s = await request(t.app).get('/v1/employees?limit=2').set('X-Force-Error', 'slow-drip');
  assert.equal(s.get('X-Chaos-Injected'), 'slow-drip');
  assert.equal(s.body.data.length, 2);
});

test('reset and truncated-body break the connection', async () => {
  const server = t.app.listen(0);
  const port = server.address().port;
  const get = (type) => new Promise((resolve) => {
    const req = http.get({ port, path: '/v1/employees/1', headers: { 'X-Force-Error': type } }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ ended: true, n, len: Number(res.headers['content-length']) }));
      res.on('error', () => resolve({ error: true }));
      res.on('aborted', () => resolve({ aborted: true }));
    });
    req.on('error', () => resolve({ error: true }));
  });
  const r1 = await get('reset');
  assert.ok(r1.error || r1.aborted);
  const r2 = await get('truncated-body');
  assert.ok(r2.error || r2.aborted || (r2.n < r2.len));
  server.closeAllConnections();
  server.close();
});

test('random error rate and per-route overrides', async () => {
  await t.ctx.settings.setMany({ errorRate: 100, errorTypes: '500' });
  await request(t.app).get('/v1/employees/1').expect(500);
  await t.ctx.settings.set('chaosRouteOverrides', [{ path: '/v1/products', errorRate: 0 }]);
  await request(t.app).get('/v1/products/1').expect(200);
  await t.ctx.settings.reset({ section: 'chaos' });
  await request(t.app).get('/v1/employees/1').expect(200);
});

test('rate limiting emits RateLimit headers and 429', async () => {
  await t.ctx.settings.set('rateLimitRpm', 3);
  for (let i = 0; i < 3; i++) {
    const r = await request(t.app).get('/v1/employees/1').set('Authorization', 'Bearer rl-test').expect(200);
    assert.equal(r.get('RateLimit-Limit'), '3');
  }
  const r = await request(t.app).get('/v1/employees/1').set('Authorization', 'Bearer rl-test').expect(429);
  assert.ok(Number(r.get('Retry-After')) >= 1);
  await t.ctx.settings.set('rateLimitRpm', 0);
});

test('custom response headers and required request headers', async () => {
  await t.ctx.settings.setMany({ responseHeaders: 'X-Env:demo;X-Team:integration', requiredHeaders: 'X-Tenant,X-Region=us' });
  const h = await request(t.app).get('/health');
  assert.equal(h.get('X-Env'), 'demo');
  const missing = await request(t.app).get('/v1/employees/1').expect(400);
  assert.equal(missing.body.errors.length, 2);
  await request(t.app).get('/v1/employees/1').set('X-Tenant', 'a').set('X-Region', 'eu').expect(400);
  const ok = await request(t.app).get('/v1/employees/1').set('X-Tenant', 'a').set('X-Region', 'us').expect(200);
  assert.equal(ok.get('X-Team'), 'integration');
  await t.ctx.settings.reset({ section: 'headers' });
  await request(t.app).get('/v1/employees/1').expect(200);
});

test('request id / correlation id echo', async () => {
  const r = await request(t.app).get('/v1/employees/1').set('X-Request-Id', 'abc-123').set('X-Correlation-Id', 'corr-9');
  assert.equal(r.get('X-Request-Id'), 'abc-123');
  assert.equal(r.get('X-Correlation-Id'), 'corr-9');
});
