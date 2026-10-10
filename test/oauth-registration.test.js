'use strict';
// Dynamic client registration (RFC 7591) with read/delete management (RFC 7592), including the flow MCP clients
// use: register a public client with a loopback redirect, then authorization_code + PKCE + refresh.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { makeApp } = require('./helpers');

let t;
before(async () => { t = await makeApp({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.close(); });

const register = (body, token) => {
  const r = request(t.app).post('/oauth/register').set('Content-Type', 'application/json');
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r.send(JSON.stringify(body));
};

function authorize(clientId, redirect, { challenge, scope = 'read', state = 's' } = {}) {
  return request(t.app).post('/oauth/authorize').type('form').send({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, scope, state,
    ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
    username: 'demo', password: 'demo', decision: 'allow',
  });
}

test('discovery advertises the registration endpoint and the registration scopes', async () => {
  const m = await request(t.app).get('/.well-known/oauth-authorization-server').expect(200);
  assert.match(m.body.registration_endpoint, /\/oauth\/register$/);
  assert.ok(m.body.token_endpoint_auth_methods_supported.includes('none'));
  assert.ok(m.body.code_challenge_methods_supported.includes('S256'));
  const o = await request(t.app).get('/.well-known/openid-configuration').expect(200);
  assert.equal(o.body.registration_endpoint, m.body.registration_endpoint);
});

test('confidential client: register, then client_credentials with the issued secret', async () => {
  const r = await register({ client_name: 'Integration', grant_types: ['client_credentials'], scope: 'read', token_endpoint_auth_method: 'client_secret_basic' }).expect(201);
  assert.equal(r.get('Cache-Control'), 'no-store');
  assert.match(r.body.client_id, /^dcr-/);
  assert.ok(r.body.client_secret);
  assert.equal(r.body.client_secret_expires_at, 0);
  assert.equal(r.body.scope, 'read');
  assert.deepEqual(r.body.grant_types, ['client_credentials']);
  assert.equal(r.body.client_name, 'Integration');
  assert.ok(r.body.registration_access_token);
  assert.equal(r.get('Location'), r.body.registration_client_uri);
  const tok = await request(t.app).post('/oauth/token').auth(r.body.client_id, r.body.client_secret).type('form').send({ grant_type: 'client_credentials' }).expect(200);
  assert.equal(tok.body.scope, 'read');
  const wide = await request(t.app).post('/oauth/token').auth(r.body.client_id, r.body.client_secret).type('form').send({ grant_type: 'client_credentials', scope: 'write' }).expect(400);
  assert.equal(wide.body.error, 'invalid_scope');
  // Only the grants it registered for.
  const page = await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: r.body.client_id, redirect_uri: 'https://x.example/cb' });
  assert.equal(page.status, 400);
});

test('public client the way MCP clients do it: loopback redirect, PKCE, refresh, any loopback port', async () => {
  const redirect = 'http://127.0.0.1:33418/callback';
  const r = await register({
    client_name: 'MCP client', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'none',
  }).expect(201);
  assert.equal(r.body.client_secret, undefined);
  assert.equal(r.body.token_endpoint_auth_method, 'none');
  assert.equal(r.body.scope, 'read write');

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  // RFC 8252: a loopback redirect may use another port than the registered one.
  const other = 'http://127.0.0.1:51234/callback';
  const page = await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: r.body.client_id, redirect_uri: other, code_challenge: challenge, code_challenge_method: 'S256' });
  assert.equal(page.status, 200);
  const login = await authorize(r.body.client_id, other, { challenge }).expect(302);
  const code = new URL(login.get('Location')).searchParams.get('code');
  const tok = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: other, client_id: r.body.client_id, code_verifier: verifier }).expect(200);
  assert.ok(tok.body.access_token);
  assert.ok(tok.body.refresh_token);
  const ref = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: r.body.client_id }).expect(200);
  assert.ok(ref.body.access_token);

  // A public client must use PKCE, cannot use client_credentials, and a different path is not the same redirect.
  const noPkce = await authorize(r.body.client_id, redirect).expect(302);
  const code2 = new URL(noPkce.get('Location')).searchParams.get('code');
  const e = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code: code2, redirect_uri: redirect, client_id: r.body.client_id }).expect(400);
  assert.equal(e.body.error, 'invalid_request');
  const cc = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'client_credentials', client_id: r.body.client_id }).expect(401);
  assert.equal(cc.body.error, 'invalid_client');
  await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: r.body.client_id, redirect_uri: 'http://127.0.0.1:33418/other' }).expect(400);
  await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: r.body.client_id, redirect_uri: 'https://evil.example/callback' }).expect(400);
});

test('custom-scheme redirect URIs work for registered clients', async () => {
  const redirect = 'myapp://oauth/callback';
  const r = await register({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }).expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const login = await authorize(r.body.client_id, redirect, { challenge }).expect(302);
  assert.match(login.get('Location'), /^myapp:\/\/oauth\/callback\?code=/);
  // Without refresh_token among its grants, no refresh token is issued.
  const code = new URL(login.get('Location')).searchParams.get('code');
  const tok = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: r.body.client_id, code_verifier: verifier }).expect(200);
  assert.equal(tok.body.refresh_token, undefined);
});

test('invalid metadata is rejected with RFC 7591 errors', async () => {
  const cases = [
    [{ grant_types: ['authorization_code'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['https://a.example/cb#frag'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['not a uri'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['https://a.example/cb'], grant_types: ['password'] }, 'invalid_client_metadata'],
    [{ redirect_uris: ['https://a.example/cb'], scope: 'admin' }, 'invalid_client_metadata'],
    [{ grant_types: ['client_credentials'], token_endpoint_auth_method: 'none' }, 'invalid_client_metadata'],
    [{ redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'private_key_jwt' }, 'invalid_client_metadata'],
    [{ redirect_uris: 'https://a.example/cb' }, 'invalid_client_metadata'],
  ];
  for (const [body, error] of cases) {
    const r = await register(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, error, JSON.stringify(body));
  }
  const bad = await request(t.app).post('/oauth/register').set('Content-Type', 'application/json').send('{not json');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_client_metadata');
});

test('RFC 7592: read and delete with the registration access token', async () => {
  const r = await register({ grant_types: ['client_credentials'] }).expect(201);
  const uri = new URL(r.body.registration_client_uri).pathname;
  const read = await request(t.app).get(uri).set('Authorization', `Bearer ${r.body.registration_access_token}`).expect(200);
  assert.equal(read.body.client_id, r.body.client_id);
  assert.equal(read.body.registration_access_token, undefined);
  const wrong = await request(t.app).get(uri).set('Authorization', 'Bearer nope').expect(401);
  assert.match(wrong.get('WWW-Authenticate'), /^Bearer error="invalid_token"/);
  await request(t.app).delete(uri).set('Authorization', `Bearer ${r.body.registration_access_token}`).expect(204);
  await request(t.app).post('/oauth/token').auth(r.body.client_id, r.body.client_secret).type('form').send({ grant_type: 'client_credentials' }).expect(401);
  // Env clients have no registration endpoint.
  await request(t.app).get('/oauth/register/demo-client').set('Authorization', 'Bearer x').expect(401);
});

test('registered clients show on the Auth page and can be deleted there', async () => {
  const r = await register({ client_name: 'Shown', grant_types: ['client_credentials'] }).expect(201);
  const auth = await request(t.app).get('/admin/api/auth').expect(200);
  const c = auth.body.clients.find((x) => x.clientId === r.body.client_id);
  assert.equal(c.source, 'registered');
  assert.equal(c.clientName, 'Shown');
  assert.equal(c.registrationTokenHash, undefined, 'the token hash is not exposed');
  assert.match(auth.body.oauth.registration, /\/oauth\/register$/);
  await request(t.app).delete(`/admin/api/oauth/clients/${r.body.client_id}`).expect(204);
});

test('registration modes: token needs the initial access token, off removes the endpoint; the limit holds', async () => {
  await t.ctx.settings.setMany({ oauthRegistration: 'token', oauthRegistrationToken: 'iat-123' });
  try {
    const no = await register({ grant_types: ['client_credentials'] }).expect(401);
    assert.equal(no.body.error, 'invalid_token');
    assert.match(no.get('WWW-Authenticate'), /^Bearer/);
    await register({ grant_types: ['client_credentials'] }, 'wrong').expect(401);
    await register({ grant_types: ['client_credentials'] }, 'iat-123').expect(201);
    await t.ctx.settings.setMany({ oauthRegistration: 'off' });
    await register({ grant_types: ['client_credentials'] }).expect(404);
    const m = await request(t.app).get('/.well-known/oauth-authorization-server').expect(200);
    assert.equal(m.body.registration_endpoint, undefined);
    await t.ctx.settings.setMany({ oauthRegistration: 'open', oauthRegistrationMax: 1 });
    const over = await register({ grant_types: ['client_credentials'] }).expect(403);
    assert.equal(over.body.error, 'access_denied');
  } finally {
    await t.ctx.settings.setMany({ oauthRegistration: 'open', oauthRegistrationToken: '', oauthRegistrationMax: 500 });
  }
});
