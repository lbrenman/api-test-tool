'use strict';
// Editing OAuth clients from the dashboard (PATCH /admin/api/oauth/clients/:id): redirect URIs, scopes, secret,
// grants and name, for dashboard-added, env (OAUTH_CLIENTS) and dynamically registered clients.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

let t;
before(async () => { t = await makeApp({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.close(); });

const authorizePage = (clientId, redirect) => request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: 'read' });
const clientsList = async () => (await request(t.app).get('/admin/api/auth').expect(200)).body.clients;

test('add a redirect URI to a dashboard client; omitted fields are kept', async () => {
  const c = (await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'dev-app', scopes: 'read', redirectUris: 'https://app.example/cb' }).expect(201)).body;
  await authorizePage('dev-app', 'http://localhost:5173/callback').expect(400);
  const u = await request(t.app).patch('/admin/api/oauth/clients/dev-app').send({ redirectUris: ['https://app.example/cb', 'http://localhost:5173/callback'] }).expect(200);
  assert.deepEqual(u.body.redirectUris, ['https://app.example/cb', 'http://localhost:5173/callback']);
  assert.equal(u.body.secret, c.secret, 'secret kept');
  assert.deepEqual(u.body.scopes, ['read'], 'scopes kept');
  await authorizePage('dev-app', 'http://localhost:5173/callback').expect(200);
  await authorizePage('dev-app', 'http://localhost:9999/callback').expect(200); // loopback: any port
  // A string with spaces or commas works too, and an empty list means "any http(s) URL" again.
  await request(t.app).patch('/admin/api/oauth/clients/dev-app').send({ redirectUris: '' }).expect(200);
  await authorizePage('dev-app', 'https://anything.example/cb').expect(200);
});

test('edit scopes, rotate the secret, restrict grants and name a client', async () => {
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'rot-app', secret: 'old-secret', scopes: 'read' }).expect(201);
  const u = await request(t.app).patch('/admin/api/oauth/clients/rot-app').send({ scopes: 'read write', secret: '', grantTypes: ['client_credentials'], clientName: 'Rotated' }).expect(200);
  assert.notEqual(u.body.secret, 'old-secret');
  assert.equal(u.body.clientName, 'Rotated');
  await request(t.app).post('/oauth/token').auth('rot-app', 'old-secret').type('form').send({ grant_type: 'client_credentials' }).expect(401);
  const tok = await request(t.app).post('/oauth/token').auth('rot-app', u.body.secret).type('form').send({ grant_type: 'client_credentials', scope: 'write' }).expect(200);
  assert.equal(tok.body.scope, 'write');
  const page = await authorizePage('rot-app', 'https://x.example/cb');
  assert.equal(page.status, 400, 'authorization_code is no longer allowed');
  await request(t.app).patch('/admin/api/oauth/clients/rot-app').send({ secret: 'chosen-secret' }).expect(200);
  await request(t.app).post('/oauth/token').auth('rot-app', 'chosen-secret').type('form').send({ grant_type: 'client_credentials' }).expect(200);
});

test('editing an env client stores an override; deleting it reverts to OAUTH_CLIENTS', async () => {
  const u = await request(t.app).patch('/admin/api/oauth/clients/demo-client').send({ redirectUris: ['myapp://callback'] }).expect(200);
  assert.equal(u.body.secret, 'demo-secret', 'the env secret is kept');
  const listed = (await clientsList()).filter((c) => c.clientId === 'demo-client');
  assert.equal(listed.length, 1, 'listed once');
  assert.equal(listed[0].source, 'dashboard');
  assert.equal(listed[0].overridesEnv, true);
  await authorizePage('demo-client', 'myapp://callback').expect(200);
  await request(t.app).post('/oauth/token').auth('demo-client', 'demo-secret').type('form').send({ grant_type: 'client_credentials' }).expect(200);
  await request(t.app).delete('/admin/api/oauth/clients/demo-client').expect(204);
  const reverted = (await clientsList()).find((c) => c.clientId === 'demo-client');
  assert.equal(reverted.source, 'env');
  assert.deepEqual(reverted.redirectUris, []);
  await authorizePage('demo-client', 'myapp://callback').expect(400);
});

test('registered clients can be edited too; rules still apply', async () => {
  const r = await request(t.app).post('/oauth/register').send({ redirect_uris: ['http://127.0.0.1:3000/cb'], token_endpoint_auth_method: 'none' }).expect(201);
  const id = r.body.client_id;
  const u = await request(t.app).patch(`/admin/api/oauth/clients/${id}`).send({ redirectUris: ['http://127.0.0.1:3000/cb', 'https://debug.example/cb'] }).expect(200);
  assert.equal(u.body.source, 'registered');
  assert.equal(u.body.registrationTokenHash, undefined);
  await authorizePage(id, 'https://debug.example/cb').expect(200);
  // the registration access token still works for RFC 7592
  await request(t.app).get(`/oauth/register/${id}`).set('Authorization', `Bearer ${r.body.registration_access_token}`).expect(200);
  // a public client has no secret and cannot get client_credentials; an auth-code client needs a redirect URI
  await request(t.app).patch(`/admin/api/oauth/clients/${id}`).send({ secret: 'x' }).expect(400);
  await request(t.app).patch(`/admin/api/oauth/clients/${id}`).send({ grantTypes: 'authorization_code client_credentials' }).expect(400);
  await request(t.app).patch(`/admin/api/oauth/clients/${id}`).send({ redirectUris: [] }).expect(400);
});

test('invalid edits are rejected', async () => {
  await request(t.app).patch('/admin/api/oauth/clients/no-such-client').send({ scopes: 'read' }).expect(404);
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'val-app' }).expect(201);
  for (const body of [{ redirectUris: ['javascript:alert(1)'] }, { redirectUris: ['https://a.example/cb#x'] }, { redirectUris: ['not a uri'] }, { scopes: '' }, { grantTypes: 'password' }]) {
    const r = await request(t.app).patch('/admin/api/oauth/clients/val-app').send(body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // Adding a client checks redirect URIs the same way.
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'bad-app', redirectUris: 'javascript:alert(1)' }).expect(400);
});
