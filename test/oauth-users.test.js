'use strict';
// OAuth users for the authorization_code (PKCE) login page: roles and attributes that end up in their tokens,
// managed from OAUTH_USERS and the admin API (/admin/api/oauth/users).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { makeApp } = require('./helpers');

let t;
before(async () => {
  t = await makeApp({ SEED_SAMPLE_FILES: 'false', OAUTH_USERS: 'demo:demo;carol:carol-pw:ops,auditor:region=EMEA,level=3,tags=["a","b"],vip=true' });
});
after(async () => { await t.close(); });

const redirect = 'https://app.example.com/callback';
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

/** Sign in as a user with PKCE and exchange the code; returns the token response body. */
async function signIn(username, password, { expectLogin = 302 } = {}) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const login = await request(t.app).post('/oauth/authorize').type('form').send({
    response_type: 'code', client_id: 'demo-client', redirect_uri: redirect, scope: 'read write', state: 'st',
    code_challenge: challenge, code_challenge_method: 'S256', username, password, decision: 'allow',
  }).expect(expectLogin);
  if (expectLogin !== 302) return null;
  const code = new URL(login.get('Location')).searchParams.get('code');
  const tok = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: 'demo-client', client_secret: 'demo-secret', code_verifier: verifier }).expect(200);
  return tok.body;
}

const setRolesClaim = (v) => request(t.app).put('/admin/api/settings').send({ oauthRolesClaim: v }).expect(200);

test('an env user with roles and attributes: Keycloak-style roles and attribute claims in the token', async () => {
  const tok = await signIn('carol', 'carol-pw');
  const p = decode(tok.access_token);
  assert.equal(p.sub, 'carol');
  assert.equal(p.preferred_username, 'carol');
  assert.deepEqual(p.realm_access, { roles: ['ops', 'auditor'] });
  assert.equal(p.roles, undefined, 'only the configured path by default');
  assert.equal(p.region, 'EMEA');
  assert.equal(p.level, 3, 'JSON values stay JSON');
  assert.deepEqual(p.tags, ['a', 'b']);
  assert.equal(p.vip, true);
  assert.equal(p.client_id, 'demo-client');
  // The token works on the API and introspection returns the same claims.
  await request(t.app).get('/v1/employees?limit=1').set('Authorization', `Bearer ${tok.access_token}`).expect(200);
  const i = await request(t.app).post('/oauth/introspect').auth('demo-client', 'demo-secret').type('form').send({ token: tok.access_token }).expect(200);
  assert.equal(i.body.active, true);
  assert.equal(i.body.username, 'carol');
  assert.deepEqual(i.body.realm_access, { roles: ['ops', 'auditor'] });
  assert.equal(i.body.region, 'EMEA');
});

test('a user without roles gets no roles claim; the default demo user still signs in', async () => {
  const p = decode((await signIn('demo', 'demo')).access_token);
  assert.equal(p.sub, 'demo');
  assert.equal(p.realm_access, undefined);
  await signIn('demo', 'wrong', { expectLogin: 401 });
});

test('add a user from the admin API, sign in, then edit and delete it', async () => {
  const created = (await request(t.app).post('/admin/api/oauth/users').send({ username: 'alice', password: 'alice', roles: 'admin, buyer', attributes: { region: 'APAC', costCenters: [4100, 4200], org: { unit: 'R&D' } } }).expect(201)).body;
  assert.deepEqual(created.roles, ['admin', 'buyer']);
  assert.equal(created.source, 'dashboard');
  await request(t.app).post('/admin/api/oauth/users').send({ username: 'alice' }).expect(409);
  const listed = (await request(t.app).get('/admin/api/oauth/users').expect(200)).body;
  assert.equal(listed.rolesClaim, 'realm_access.roles');
  assert.ok(listed.items.some((u) => u.username === 'alice'));
  assert.ok((await request(t.app).get('/admin/api/auth').expect(200)).body.users.some((u) => u.username === 'alice'));

  const tok = await signIn('alice', 'alice');
  let p = decode(tok.access_token);
  assert.deepEqual(p.realm_access.roles, ['admin', 'buyer']);
  assert.deepEqual(p.costCenters, [4100, 4200]);
  assert.deepEqual(p.org, { unit: 'R&D' });

  // Edit roles only: password and attributes are kept, and a refresh picks up the new roles.
  const edited = (await request(t.app).patch('/admin/api/oauth/users/alice').send({ roles: ['viewer'] }).expect(200)).body;
  assert.equal(edited.password, 'alice');
  assert.equal(edited.attributes.region, 'APAC');
  const ref = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: 'demo-client', client_secret: 'demo-secret' }).expect(200);
  p = decode(ref.body.access_token);
  assert.deepEqual(p.realm_access.roles, ['viewer']);
  assert.equal(p.region, 'APAC');

  // Deleting the user stops their refresh tokens.
  await request(t.app).delete('/admin/api/oauth/users/alice').expect(204);
  const gone = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: ref.body.refresh_token, client_id: 'demo-client', client_secret: 'demo-secret' }).expect(400);
  assert.equal(gone.body.error, 'invalid_grant');
  await signIn('alice', 'alice', { expectLogin: 401 });
  await request(t.app).delete('/admin/api/oauth/users/alice').expect(404);
});

test('several roles claim paths write the roles to each', async () => {
  await setRolesClaim('realm_access.roles,roles,resource_access.my-app.roles');
  try {
    const p = decode((await signIn('carol', 'carol-pw')).access_token);
    assert.deepEqual(p.realm_access.roles, ['ops', 'auditor']);
    assert.deepEqual(p.roles, ['ops', 'auditor']);
    assert.deepEqual(p.resource_access, { 'my-app': { roles: ['ops', 'auditor'] } });
  } finally {
    await setRolesClaim('realm_access.roles');
  }
});

test('reserved claims and bad input are refused', async () => {
  for (const attributes of [{ sub: 'admin' }, { scope: 'write' }, { realm_access: { roles: ['x'] } }, { preferred_username: 'x' }]) {
    const r = await request(t.app).post('/admin/api/oauth/users').send({ username: 'mallory', password: 'pw', attributes }).expect(400);
    assert.match(r.body.detail, /reserved/);
  }
  await request(t.app).post('/admin/api/oauth/users').send({ username: 'has space', password: 'pw' }).expect(400);
  await request(t.app).post('/admin/api/oauth/users').send({ username: 'm2', attributes: [1, 2] }).expect(400);
  await request(t.app).patch('/admin/api/oauth/users/nobody').send({ roles: ['x'] }).expect(404);
});

test('editing an env user stores an override; deleting it reverts to OAUTH_USERS', async () => {
  const u = (await request(t.app).patch('/admin/api/oauth/users/carol').send({ attributes: { region: 'LATAM' } }).expect(200)).body;
  assert.equal(u.overridesEnv, true);
  assert.equal(u.password, 'carol-pw', 'the env password is kept');
  assert.deepEqual(u.roles, ['ops', 'auditor'], 'the env roles are kept');
  const listed = (await request(t.app).get('/admin/api/oauth/users').expect(200)).body.items.filter((x) => x.username === 'carol');
  assert.equal(listed.length, 1, 'listed once');
  let p = decode((await signIn('carol', 'carol-pw')).access_token);
  assert.equal(p.region, 'LATAM');
  assert.equal(p.level, undefined, 'attributes are replaced as a whole');
  await request(t.app).delete('/admin/api/oauth/users/carol').expect(204);
  p = decode((await signIn('carol', 'carol-pw')).access_token);
  assert.equal(p.region, 'EMEA');
  assert.equal(p.level, 3);
  await request(t.app).delete('/admin/api/oauth/users/carol').expect(404);
});

test('the dashboard test token can be issued as a user', async () => {
  const r = (await request(t.app).post('/admin/api/auth/test-token').send({ clientId: 'demo-client', username: 'carol' }).expect(200)).body;
  assert.equal(r.username, 'carol');
  assert.equal(r.decoded.payload.sub, 'carol');
  assert.deepEqual(r.decoded.payload.realm_access.roles, ['ops', 'auditor']);
  const plain = (await request(t.app).post('/admin/api/auth/test-token').send({ clientId: 'demo-client' }).expect(200)).body;
  assert.equal(plain.decoded.payload.sub, 'demo-client');
  assert.equal(plain.decoded.payload.realm_access, undefined);
  await request(t.app).post('/admin/api/auth/test-token').send({ clientId: 'demo-client', username: 'nobody' }).expect(400);
});
