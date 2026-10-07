'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

test('catch-all captures unknown paths with the actual path, auth and body', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', INSPECTOR_RETENTION: '5' });
  try {
    const r = await request(t.app).post('/hooks/order-created?x=1').auth('svc', 'pw').send({ orderId: 42 }).expect(200);
    assert.equal(r.body.status, 'captured');
    assert.equal(r.body.path, '/hooks/order-created');
    const list = await request(t.app).get('/admin/api/inspector').expect(200);
    assert.equal(list.body[0].path, '/hooks/order-created');
    const e = (await request(t.app).get(`/admin/api/inspector/${list.body[0].id}`).expect(200)).body;
    assert.equal(e.query.x, '1');
    assert.equal(e.auth.basic.username, 'svc');
    assert.equal(e.body.kind, 'json');
    assert.match(e.curl, /curl -X POST/);
    assert.equal(e.response.status, 200);

    // JWT detection + multipart parsing
    const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"me"}').toString('base64url')}.sig`;
    await request(t.app).put('/anything/else').set('Authorization', `Bearer ${jwt}`).attach('f', Buffer.from('abc'), 'f.txt').field('k', 'v').expect(200);
    const e2 = (await request(t.app).get(`/admin/api/inspector/${(await request(t.app).get('/admin/api/inspector')).body[0].id}`)).body;
    assert.equal(e2.auth.jwt.claims.sub, 'me');
    assert.equal(e2.body.multipart.parts.find((p) => p.type === 'file').filename, 'f.txt');

    // rules: first match wins, templates
    await t.ctx.settings.set('inspectorRules', [{ method: 'POST', path: '/hooks/{name}', status: 202, body: { hook: '{{params.name}}', id: '{{id}}' }, headers: [{ name: 'X-Rule', value: 'yes' }] }]);
    const rr = await request(t.app).post('/hooks/payment').send({}).expect(202);
    assert.equal(rr.body.hook, 'payment');
    assert.equal(rr.get('X-Rule'), 'yes');

    // retention
    for (let i = 0; i < 8; i++) await request(t.app).get(`/r/${i}`);
    assert.ok((await request(t.app).get('/admin/api/inspector')).body.length <= 5);

    // with INSPECTOR_LOG_ALL off, reserved prefixes are not captured
    await t.ctx.settings.set('inspectorLogAll', false);
    await request(t.app).get('/v1/unknown').expect(404);
    const last = (await request(t.app).get('/admin/api/inspector')).body[0];
    assert.notEqual(last.path, '/v1/unknown');

    // back on: /v1 traffic is captured
    await t.ctx.settings.set('inspectorLogAll', true);
    await request(t.app).get('/v1/employees/1').expect(200);
    await new Promise((r) => setTimeout(r, 50));
    const v1 = (await request(t.app).get('/admin/api/inspector')).body.find((x) => x.path === '/v1/employees/1');
    assert.equal(v1.kind, 'v1');
    assert.equal(v1.status, 200);
  } finally { await t.close(); }
});

test('API traffic is recorded by default: /v1 (incl. early rejections), /oauth, dropped connections; plumbing is not', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', AUTH_MODE: 'apikey', API_KEY: 'k1' });
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const all = async () => (await request(t.app).get('/admin/api/inspector')).body;
  try {
    assert.equal(t.ctx.settings.get('inspectorLogAll'), true);

    // authorised call: request + real response body
    await request(t.app).get('/v1/employees?limit=2').set('X-API-Key', 'k1').expect(200);
    // rejected by auth
    await request(t.app).get('/v1/products').expect(401);
    // rejected by the body parser (never reaches the routers)
    await request(t.app).post('/v1/employees').set('X-API-Key', 'k1').set('Content-Type', 'application/json').send('{bad json').expect(400);
    // OAuth token request (form body kept)
    await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'client_credentials', client_id: 'nobody', client_secret: 'x' });
    // the tool's own plumbing is never recorded
    await request(t.app).get('/health').expect(200);
    await request(t.app).get('/openapi.json').expect(200);
    await request(t.app).get('/dashboard/').expect(200);
    await settle();

    const items = await all();
    const ok = items.find((x) => x.path === '/v1/employees' && x.method === 'GET');
    assert.equal(ok.kind, 'v1');
    assert.equal(ok.status, 200);
    const okFull = (await request(t.app).get(`/admin/api/inspector/${ok.id}`)).body;
    assert.equal(okFull.query.limit, '2');
    assert.equal(okFull.response.body.kind, 'json');
    assert.ok(JSON.parse(okFull.response.body.text).data.length === 2);

    assert.equal(items.find((x) => x.path === '/v1/products').status, 401);
    const bad = items.find((x) => x.path === '/v1/employees' && x.method === 'POST');
    assert.equal(bad.status, 400);
    assert.equal((await request(t.app).get(`/admin/api/inspector/${bad.id}`)).body.body.text, '{bad json');

    const tok = items.find((x) => x.path === '/oauth/token');
    assert.equal(tok.kind, 'oauth');
    assert.equal((await request(t.app).get(`/admin/api/inspector/${tok.id}`)).body.body.fields.grant_type, 'client_credentials');

    for (const p of ['/health', '/openapi.json', '/dashboard/', '/admin/api/inspector']) assert.ok(!items.some((x) => x.path === p), `${p} should not be recorded`);
  } finally { await t.close(); }
});

test('connections dropped by chaos are recorded as aborted', async () => {
  const { listen } = require('./helpers');
  const t = await listen({ SEED_SAMPLE_FILES: 'false' });
  try {
    await fetch(`${t.url}/v1/employees/1`, { headers: { 'X-Force-Error': 'reset' } }).catch(() => null);
    let e;
    for (let i = 0; i < 40 && !e; i++) {
      await new Promise((r) => setTimeout(r, 50));
      e = (await t.ctx.inspector.list()).find((x) => x.path === '/v1/employees/1');
    }
    assert.ok(e, 'dropped request should be recorded');
    assert.equal(e.aborted, true);
  } finally { await t.stop(); }
});

test('admin API requires ADMIN_PASSWORD when set; session cookie and Basic fallback', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', ADMIN_PASSWORD: 's3cret' });
  try {
    await request(t.app).get('/admin/api/settings').expect(401);
    await request(t.app).get('/admin/api/settings').auth('admin', 's3cret').expect(200);
    await request(t.app).post('/admin/api/login').send({ password: 'nope' }).expect(401);
    const login = await request(t.app).post('/admin/api/login').send({ password: 's3cret' }).expect(200);
    const cookie = login.get('Set-Cookie')[0].split(';')[0];
    await request(t.app).get('/admin/api/overview').set('Cookie', cookie).expect(200);
    const s = await request(t.app).get('/admin/api/session').expect(200);
    assert.equal(s.body.passwordRequired, true);
  } finally { await t.close(); }
});

test('dashboard overrides persist across restart; reset returns to env defaults', async () => {
  const env = { SEED_SAMPLE_FILES: 'false', DATE_FORMAT: 'iso', ERROR_RATE: '0' };
  const a = await makeApp(env);
  const dir = a.dir;
  await request(a.app).put('/admin/api/settings').send({ dateFormat: 'epoch-ms', errorTypes: '502' }).expect(200);
  await request(a.app).put('/admin/api/settings').send({ port: 1234 }).expect(400);
  await a.close();

  const b = await makeApp(env, { dir });
  try {
    const s = (await request(b.app).get('/admin/api/settings')).body.settings;
    const df = s.find((x) => x.key === 'dateFormat');
    assert.equal(df.value, 'epoch-ms');
    assert.equal(df.source, 'override');
    assert.equal(s.find((x) => x.key === 'errorRate').source, 'env');
    const emp = (await request(b.app).get('/v1/employees/1')).body;
    assert.equal(typeof emp.createdAt, 'number');
    await request(b.app).post('/admin/api/settings/reset').send({ section: 'dates' }).expect(200);
    assert.match((await request(b.app).get('/v1/employees/1')).body.createdAt, /Z$/);
    await request(b.app).post('/admin/api/settings/reset').send({}).expect(200);
    assert.equal(b.ctx.settings.source('errorTypes'), 'default');
  } finally { await b.close(); }
});

test('DATE_FORMAT changes API output and the generated OpenAPI; re-seed works', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  try {
    const cases = {
      iso: (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v),
      'iso-offset': (v) => /[+-]05:30$/.test(v),
      'epoch-s': (v) => Number.isInteger(v) && v < 1e11,
      'epoch-ms': (v) => Number.isInteger(v) && v > 1e11,
      rfc1123: (v) => / GMT$/.test(v),
      custom: (v) => /^\d{4}\/\d{2}\/\d{2}$/.test(v),
    };
    for (const [fmt, ok] of Object.entries(cases)) {
      await t.ctx.settings.setMany({ dateFormat: fmt, dateTzOffset: '+05:30', dateFormatPattern: 'YYYY/MM/DD' });
      const e = (await request(t.app).get('/v1/employees/1')).body;
      assert.ok(ok(e.createdAt), `${fmt}: ${e.createdAt}`);
      assert.match(e.hireDate, /^\d{4}-\d{2}-\d{2}$/);
      const spec = (await request(t.app).get('/openapi.json')).body;
      const ts = spec.components.schemas.Employee.properties.createdAt;
      if (fmt.startsWith('epoch')) assert.equal(ts.type, 'integer'); else assert.equal(ts.type, 'string');
    }
    // input accepts any supported format
    await t.ctx.settings.set('dateFormat', 'iso');
    const c = await request(t.app).post('/v1/employees').send({ firstName: 'T', lastName: 'S', email: 't@example.com', departmentId: 1, certifications: [{ name: 'X', issuedAt: 1767225600, expiresAt: 'Thu, 01 Jan 2032 00:00:00 GMT' }] }).expect(201);
    assert.equal(c.body.certifications[0].issuedAt, '2026-01-01T00:00:00.000Z');
    const r = await request(t.app).post('/admin/api/data/seed').send({ employees: 12, products: 7, seed: 7, sampleFiles: false }).expect(200);
    assert.equal(r.body.employees, 12);
    assert.equal((await request(t.app).get('/v1/employees?limit=1')).body.meta.total, 12);
  } finally { await t.close(); }
});

test('generated OpenAPI reflects auth mode and required headers', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', AUTH_MODE: 'oauth2', REQUIRED_HEADERS: 'X-Tenant' });
  try {
    const spec = (await request(t.app).get('/openapi.json')).body;
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.components.securitySchemes.OAuth2.flows.clientCredentials.tokenUrl.endsWith('/oauth/token'));
    assert.ok(Object.values(spec.components.parameters).some((p) => p.name === 'X-Tenant' && p.required));
    for (const s of ['offset', 'page', 'cursor', 'keyset', 'link', 'hal', 'token']) assert.ok(spec.paths[`/v1/p/${s}/employees`]);
    const yaml = await request(t.app).get('/openapi.yaml').expect(200);
    assert.match(yaml.text, /openapi: 3\.1\.0/);
  } finally { await t.close(); }
});

test('a single capture can be deleted without touching the others', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  try {
    await request(t.app).post('/hooks/keep').send({ a: 1 }).expect(200);
    await request(t.app).post('/hooks/drop').send({ b: 2 }).expect(200);
    const before = (await request(t.app).get('/admin/api/inspector').expect(200)).body;
    const drop = before.find((x) => x.path === '/hooks/drop');
    const events = [];
    t.ctx.inspector.on('delete', (e) => events.push(e));
    await request(t.app).delete(`/admin/api/inspector/${drop.id}`).expect(204);
    assert.deepEqual(events, [{ id: drop.id }]);
    const after = (await request(t.app).get('/admin/api/inspector').expect(200)).body;
    assert.equal(after.length, before.length - 1);
    assert.ok(after.some((x) => x.path === '/hooks/keep'));
    assert.ok(!after.some((x) => x.id === drop.id));
    await request(t.app).get(`/admin/api/inspector/${drop.id}`).expect(404);
    const nf = await request(t.app).delete(`/admin/api/inspector/${drop.id}`).expect(404);
    assert.match(nf.headers['content-type'], /problem\+json/);
  } finally {
    await t.close();
  }
});
