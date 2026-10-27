'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { makeApp, waitFor } = require('./helpers');

let t;
before(async () => { t = await makeApp({ SEED_SAMPLE_FILES: 'false', AUTH_MODE: 'bearer', INSPECTOR_LOG_ALL: 'true' }); });
after(async () => { await t.close(); });

async function ccToken(scope) {
  const r = await request(t.app).post('/oauth/token').auth('demo-client', 'demo-secret').type('form')
    .send({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) }).expect(200);
  return r.body.access_token;
}

test('built-in profiles: one per auth mode, the global mode is untouched', async () => {
  await request(t.app).get('/v1/employees/1').expect(401); // global: bearer
  await request(t.app).get('/p/none/v1/employees/1').expect(200);
  await request(t.app).get('/p/apikey/v1/employees/1').expect(401);
  await request(t.app).get('/p/apikey/v1/employees/1').set('X-API-Key', 'demo-key').expect(200);
  await request(t.app).get('/p/basic/v1/employees/1').auth('demo', 'demo').expect(200);
  await request(t.app).get('/p/bearer/v1/employees/1').set('Authorization', 'Bearer demo-token').expect(200);
  const tok = await ccToken();
  await request(t.app).get('/p/jwt/v1/employees/1').set('Authorization', `Bearer ${tok}`).expect(200);
  await request(t.app).get('/p/oauth2/v1/employees/1').set('Authorization', `Bearer ${tok}`).expect(200);
  assert.equal(t.ctx.settings.get('authMode'), 'bearer');
});

test('auth runs inside the profile after the body is parsed (POST with a JSON body)', async () => {
  await request(t.app).post('/p/apikey/v1/departments').send({ name: 'Prof', code: 'PF' }).expect(401);
  await request(t.app).post('/p/apikey/v1/departments').set('X-API-Key', 'demo-key').send({ name: 'Prof', code: 'PF' }).expect(201);
  const ro = await ccToken('read');
  await request(t.app).post('/p/oauth2/v1/departments').set('Authorization', `Bearer ${ro}`).send({ name: 'X', code: 'XQ' }).expect(403);
});

test('HMAC signs the path as sent, prefix included', async () => {
  const pathQ = '/p/hmac/v1/employees?limit=2';
  const date = new Date().toUTCString();
  const empty = crypto.createHash('sha256').update('').digest('hex');
  const sig = crypto.createHmac('sha256', 'demo-hmac').update(['GET', pathQ, date, empty].join('\n')).digest('base64');
  await request(t.app).get(pathQ).set('Authorization', `HMAC demo:${sig}`).set('X-Timestamp', date).expect(200);
  const bad = crypto.createHmac('sha256', 'demo-hmac').update(['GET', '/v1/employees?limit=2', date, empty].join('\n')).digest('base64');
  await request(t.app).get(pathQ).set('Authorization', `HMAC demo:${bad}`).set('X-Timestamp', date).expect(401);
});

test('links stay inside the profile; the OAuth server stays at the root', async () => {
  const r = await request(t.app).get('/p/none/v1/p/link/employees?limit=2').expect(200);
  assert.match(r.get('Link'), /<http:\/\/localhost\/p\/none\/v1\/p\/link\/employees\?[^>]*>; rel="next"/);
  const hal = await request(t.app).get('/p/none/v1/p/hal/employees?limit=2').expect(200);
  assert.match(JSON.stringify(hal.body._links), /http:\/\/localhost\/p\/none\/v1\/p\/hal\/employees/);
  const spec = await request(t.app).get('/p/none/openapi.json').expect(200);
  assert.ok(JSON.stringify(spec.body.servers).includes('/p/none'));
  const md = await request(t.app).get('/p/oauth2/.well-known/oauth-authorization-server').expect(200);
  assert.equal(md.body.issuer, 'http://localhost');
  assert.equal(md.body.token_endpoint, 'http://localhost/oauth/token');
  const prm = await request(t.app).get('/.well-known/oauth-protected-resource/p/oauth2/mcp').expect(200);
  assert.equal(prm.body.resource, 'http://localhost/p/oauth2/mcp');
  assert.deepEqual(prm.body.authorization_servers, ['http://localhost']);
  const mcp = await request(t.app).post('/p/oauth2/mcp').set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(401);
  assert.match(mcp.get('WWW-Authenticate'), /resource_metadata="http:\/\/localhost\/p\/oauth2\/\.well-known\/oauth-protected-resource\/mcp"/);
  await request(t.app).get('/p/oauth2/.well-known/oauth-protected-resource/mcp').expect(200);
});

test('unknown profile and admin paths inside a profile are 404', async () => {
  const r = await request(t.app).get('/p/nope/v1/employees').expect(404);
  assert.equal(r.body.code, 'profile-not-found');
  await request(t.app).get('/p/none/admin/api/settings').expect(404);
  await request(t.app).get('/p/none/dashboard/').expect(404);
});

test('custom profiles: CRUD, validation and per-profile chaos and headers', async () => {
  await request(t.app).post('/admin/api/profiles').send({ name: 'none', settings: {} }).expect(409);
  await request(t.app).post('/admin/api/profiles').send({ name: 'Bad Name', settings: {} }).expect(400);
  await request(t.app).post('/admin/api/profiles').send({ name: 'x', settings: { adminPassword: 'x' } }).expect(400);
  await request(t.app).post('/admin/api/profiles').send({ name: 'x', settings: { authMode: 'nope' } }).expect(400);
  const created = await request(t.app).post('/admin/api/profiles').send({
    name: 'demo-chaos', description: 'flaky', settings: { authMode: 'none', errorRate: 100, errorTypes: '503', responseHeaders: 'X-Profile: demo-chaos' },
  }).expect(201);
  assert.equal(created.body.settings.errorRate, 100);
  const r = await request(t.app).get('/p/demo-chaos/v1/employees/1').expect(503);
  assert.equal(r.get('X-Profile'), 'demo-chaos');
  await request(t.app).get('/v1/employees/1').set('Authorization', 'Bearer demo-token').expect(200); // global unaffected
  await request(t.app).patch('/admin/api/profiles/demo-chaos').send({ settings: { authMode: 'none' } }).expect(200);
  await request(t.app).get('/p/demo-chaos/v1/employees/1').expect(200);
  const list = (await request(t.app).get('/admin/api/profiles').expect(200)).body;
  assert.ok(list.profiles.find((p) => p.name === 'hmac' && p.builtIn));
  assert.ok(list.profiles.find((p) => p.name === 'demo-chaos' && !p.builtIn && p.url === 'http://localhost/p/demo-chaos'));
  assert.ok(list.keys.includes('errorRate'));
  await request(t.app).delete('/admin/api/profiles/hmac').expect(409);
  await request(t.app).delete('/admin/api/profiles/demo-chaos').expect(204);
  await request(t.app).get('/p/demo-chaos/v1/employees/1').expect(404);
});

test('rate limits are per profile, and the inspector records the profile', async () => {
  await request(t.app).post('/admin/api/profiles').send({ name: 'limited', settings: { authMode: 'none', rateLimitRpm: 1 } }).expect(201);
  const id = `prof-${crypto.randomBytes(4).toString('hex')}`;
  await request(t.app).get('/p/limited/v1/employees/1').set('X-Request-Id', id).expect(200);
  await request(t.app).get('/p/limited/v1/employees/1').expect(429);
  await request(t.app).get('/p/none/v1/employees/1').expect(200);
  const entry = await waitFor(async () => (await request(t.app).get('/admin/api/inspector').expect(200)).body.find((e) => e.profile === 'limited' && e.status === 200));
  assert.equal(entry.path, '/p/limited/v1/employees/1');
});

test('admin /auth can describe a profile for the dashboard guides', async () => {
  const a = (await request(t.app).get('/admin/api/auth?profile=hmac').expect(200)).body;
  assert.equal(a.mode, 'hmac');
  assert.equal(a.apiBase, 'http://localhost/p/hmac');
  assert.equal(a.oauth.tokenUrl, 'http://localhost/oauth/token');
  assert.equal((await request(t.app).get('/admin/api/auth').expect(200)).body.mode, 'bearer');
});
