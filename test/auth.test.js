'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { makeApp } = require('./helpers');

let t;
before(async () => { t = await makeApp({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.close(); });

const setMode = (mode, extra = {}) => t.ctx.settings.setMany({ authMode: mode, ...extra });

async function ccToken(scope) {
  const r = await request(t.app).post('/oauth/token').auth('demo-client', 'demo-secret').type('form')
    .send({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) }).expect(200);
  return r.body;
}

test('none', async () => {
  await setMode('none');
  await request(t.app).get('/v1/employees/1').expect(200);
});

test('apikey in header and query', async () => {
  await setMode('apikey', { apiKeyIn: 'header', apiKeyName: 'X-API-Key', apiKey: 'k1' });
  const r = await request(t.app).get('/v1/employees/1').expect(401);
  assert.match(r.get('WWW-Authenticate'), /ApiKey/);
  await request(t.app).get('/v1/employees/1').set('X-API-Key', 'wrong').expect(401);
  await request(t.app).get('/v1/employees/1').set('X-API-Key', 'k1').expect(200);
  await setMode('apikey', { apiKeyIn: 'query', apiKeyName: 'api_key' });
  await request(t.app).get('/v1/employees/1?api_key=k1').expect(200);
  await request(t.app).get('/v1/employees/1').set('X-API-Key', 'k1').expect(401);
});

test('basic', async () => {
  await setMode('basic');
  await request(t.app).get('/v1/employees/1').expect(401);
  await request(t.app).get('/v1/employees/1').auth('demo', 'bad').expect(401);
  await request(t.app).get('/v1/employees/1').auth('demo', 'demo').expect(200);
});

test('bearer (static token)', async () => {
  await setMode('bearer');
  await request(t.app).get('/v1/employees/1').set('Authorization', 'Bearer nope').expect(401);
  await request(t.app).get('/v1/employees/1').set('Authorization', 'Bearer demo-token').expect(200);
});

test('client_credentials token is accepted under jwt and oauth2; scopes enforced', async () => {
  const full = await ccToken();
  assert.equal(full.token_type, 'Bearer');
  assert.equal(full.scope, 'read write');
  await setMode('jwt');
  await request(t.app).get('/v1/employees/1').set('Authorization', `Bearer ${full.access_token}`).expect(200);
  await request(t.app).get('/v1/employees/1').set('Authorization', 'Bearer a.b.c').expect(401);
  await setMode('oauth2');
  await request(t.app).get('/v1/employees/1').set('Authorization', `Bearer ${full.access_token}`).expect(200);
  const ro = await ccToken('read');
  await request(t.app).get('/v1/employees/1').set('Authorization', `Bearer ${ro.access_token}`).expect(200);
  const denied = await request(t.app).post('/v1/departments').set('Authorization', `Bearer ${ro.access_token}`).send({ name: 'X', code: 'XX' }).expect(403);
  assert.match(denied.get('WWW-Authenticate'), /insufficient_scope/);
  await request(t.app).post('/oauth/token').auth('demo-client', 'demo-secret').type('form').send({ grant_type: 'client_credentials', scope: 'admin' }).expect(400);
  await request(t.app).post('/oauth/token').auth('demo-client', 'wrong').type('form').send({ grant_type: 'client_credentials' }).expect(401);
});

test('HS256 tokens work too', async () => {
  await setMode('jwt', { jwtAlg: 'HS256' });
  const tok = await ccToken();
  const [h] = tok.access_token.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).alg, 'HS256');
  await request(t.app).get('/v1/employees/1').set('Authorization', `Bearer ${tok.access_token}`).expect(200);
  await t.ctx.settings.set('jwtAlg', 'RS256');
});

test('introspection and revocation', async () => {
  await setMode('oauth2');
  const tok = await ccToken();
  const i = await request(t.app).post('/oauth/introspect').auth('demo-client', 'demo-secret').type('form').send({ token: tok.access_token }).expect(200);
  assert.equal(i.body.active, true);
  assert.equal(i.body.client_id, 'demo-client');
  await request(t.app).post('/oauth/revoke').auth('demo-client', 'demo-secret').type('form').send({ token: tok.access_token }).expect(200);
  const i2 = await request(t.app).post('/oauth/introspect').auth('demo-client', 'demo-secret').type('form').send({ token: tok.access_token }).expect(200);
  assert.equal(i2.body.active, false);
  await request(t.app).get('/v1/employees/1').set('Authorization', `Bearer ${tok.access_token}`).expect(401);
});

test('authorization_code + PKCE + refresh_token', async () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirect = 'https://app.example.com/callback';
  const page = await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: 'demo-client', redirect_uri: redirect, scope: 'read', state: 's1', code_challenge: challenge, code_challenge_method: 'S256' }).expect(200);
  assert.match(page.text, /Sign in/);
  const login = await request(t.app).post('/oauth/authorize').type('form').send({
    response_type: 'code', client_id: 'demo-client', redirect_uri: redirect, scope: 'read', state: 's1',
    code_challenge: challenge, code_challenge_method: 'S256', username: 'demo', password: 'demo', decision: 'allow',
  }).expect(302);
  const loc = new URL(login.get('Location'));
  assert.equal(loc.searchParams.get('state'), 's1');
  const code = loc.searchParams.get('code');
  await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: 'demo-client', client_secret: 'demo-secret', code_verifier: 'wrong' }).expect(400);
  // code is single-use: get a new one
  const login2 = await request(t.app).post('/oauth/authorize').type('form').send({
    response_type: 'code', client_id: 'demo-client', redirect_uri: redirect, scope: 'read', state: 's2',
    code_challenge: challenge, code_challenge_method: 'S256', username: 'demo', password: 'demo', decision: 'allow',
  }).expect(302);
  const code2 = new URL(login2.get('Location')).searchParams.get('code');
  const tok = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code: code2, redirect_uri: redirect, client_id: 'demo-client', client_secret: 'demo-secret', code_verifier: verifier }).expect(200);
  assert.ok(tok.body.refresh_token);
  const payload = JSON.parse(Buffer.from(tok.body.access_token.split('.')[1], 'base64url').toString());
  assert.equal(payload.sub, 'demo');
  const ref = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: 'demo-client', client_secret: 'demo-secret' }).expect(200);
  assert.ok(ref.body.access_token);
  await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: 'demo-client', client_secret: 'demo-secret' }).expect(400);
});

test('discovery documents and JWKS', async () => {
  const m = await request(t.app).get('/.well-known/oauth-authorization-server').expect(200);
  assert.match(m.body.token_endpoint, /\/oauth\/token$/);
  const j = await request(t.app).get('/.well-known/jwks.json').expect(200);
  assert.equal(j.body.keys[0].kty, 'RSA');
  await request(t.app).get('/.well-known/openid-configuration').expect(200);
});

test('hmac', async () => {
  await setMode('hmac');
  const sign = (method, path, body, ts = String(Math.floor(Date.now() / 1000))) => {
    const hash = crypto.createHash('sha256').update(body || '').digest('hex');
    const sig = crypto.createHmac('sha256', 'demo-hmac').update([method, path, ts, hash].join('\n')).digest('base64');
    return { Authorization: `HMAC demo:${sig}`, 'X-Timestamp': ts };
  };
  await request(t.app).get('/v1/employees/1').expect(401);
  await request(t.app).get('/v1/employees/1?fields=id').set(sign('GET', '/v1/employees/1?fields=id')).expect(200);
  const body = JSON.stringify({ name: 'Signed', code: 'SGN' });
  await request(t.app).post('/v1/departments').set(sign('POST', '/v1/departments', body)).set('Content-Type', 'application/json').send(body).expect(201);
  const bad = await request(t.app).post('/v1/departments').set(sign('POST', '/v1/departments', 'other')).set('Content-Type', 'application/json').send(body).expect(401);
  assert.equal(bad.body.code, 'bad-signature');
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  await request(t.app).get('/v1/employees/1').set(sign('GET', '/v1/employees/1', '', old)).expect(401);
  await setMode('none');
});

test('platform endpoints stay open in every mode', async () => {
  await setMode('basic');
  await request(t.app).get('/health').expect(200);
  await request(t.app).get('/openapi.json').expect(200);
  await request(t.app).post('/oauth/token').auth('demo-client', 'demo-secret').type('form').send({ grant_type: 'client_credentials' }).expect(200);
  await setMode('none');
});
