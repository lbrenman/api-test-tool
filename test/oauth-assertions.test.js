'use strict';
// Client authentication with signed JWTs (RFC 7523): private_key_jwt (RSA, EC, Ed25519 keys from jwks or jwks_uri)
// and client_secret_jwt (HS256 over the secret), the dashboard helpers, registration and the negative cases.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const request = require('supertest');
const jose = require('jose');
const { makeApp } = require('./helpers');

const BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const AUD = 'http://localhost/oauth/token';
let t;
before(async () => { t = await makeApp({ SEED_SAMPLE_FILES: 'false', OAUTH_REGISTRATION: 'open', OAUTH_REGISTRATION_GRANTS: 'client_credentials authorization_code' }); });
after(async () => { await t.close(); });

async function sign(key, { iss, sub = iss, aud = AUD, alg, kid, exp = '2m', jti = crypto.randomUUID(), header = {} }) {
  let j = new jose.SignJWT({}).setProtectedHeader({ alg, ...(kid ? { kid } : {}), ...header }).setIssuer(iss).setSubject(sub).setAudience(aud).setIssuedAt();
  if (jti) j = j.setJti(jti);
  if (exp) j = j.setExpirationTime(exp);
  return j.sign(key);
}
const token = (assertion, extra = {}) => request(t.app).post('/oauth/token').type('form')
  .send({ grant_type: 'client_credentials', client_assertion_type: BEARER, client_assertion: assertion, ...extra });

test('metadata advertises the JWT client authentication methods', async () => {
  const m = (await request(t.app).get('/.well-known/oauth-authorization-server').expect(200)).body;
  for (const x of ['client_secret_jwt', 'private_key_jwt']) assert.ok(m.token_endpoint_auth_methods_supported.includes(x));
  assert.ok(m.token_endpoint_auth_signing_alg_values_supported.includes('ES256'));
  assert.ok(m.token_endpoint_auth_signing_alg_values_supported.includes('HS256'));
});

for (const [alg, gen] of [['RS256', () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })], ['ES256', () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })], ['EdDSA', () => crypto.generateKeyPairSync('ed25519')]]) {
  test(`private_key_jwt with an ${alg} key from the client's jwks`, async () => {
    const id = `pkj-${alg.toLowerCase()}`;
    const { publicKey, privateKey } = gen();
    const jwk = publicKey.export({ format: 'jwk' });
    const c = (await request(t.app).post('/admin/api/oauth/clients').send({ clientId: id, scopes: 'read', jwks: { keys: [jwk] }, tokenEndpointAuthMethod: 'private_key_jwt' }).expect(201)).body;
    const kid = c.jwks.keys[0].kid;
    assert.ok(kid, 'a kid (thumbprint) is added');
    const tok = await token(await sign(privateKey, { iss: id, alg, kid })).expect(200);
    assert.equal(jose.decodeJwt(tok.body.access_token).client_id, id);
    // The secret no longer works for this client.
    await request(t.app).post('/oauth/token').auth(id, c.secret).type('form').send({ grant_type: 'client_credentials' }).expect(401);
  });
}

test('a PEM public key is accepted as jwks; private material is refused', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'pem-client', jwks: publicKey.export({ type: 'spki', format: 'pem' }), tokenEndpointAuthMethod: 'private_key_jwt' }).expect(201);
  await token(await sign(privateKey, { iss: 'pem-client', alg: 'ES256' })).expect(200);
  const r = await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'leaky', jwks: { keys: [privateKey.export({ format: 'jwk' })] } }).expect(400);
  assert.match(r.body.detail, /Only public keys/);
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'nokeys', tokenEndpointAuthMethod: 'private_key_jwt' }).expect(400);
});

test('negative cases: wrong aud, expired, too long, replayed jti, unknown kid, wrong key, iss/sub mismatch', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'neg-client', jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }] }, tokenEndpointAuthMethod: 'private_key_jwt' }).expect(201);
  const base = { iss: 'neg-client', alg: 'ES256', kid: 'k1' };
  const expectFail = async (assertion, re, extra) => {
    const r = await token(assertion, extra).expect(401);
    assert.equal(r.body.error, 'invalid_client');
    assert.match(r.body.error_description, re);
  };
  await expectFail(await sign(privateKey, { ...base, aud: 'https://elsewhere.example/token' }), /aud must be one of/);
  await expectFail(await sign(privateKey, { ...base, exp: Math.floor(Date.now() / 1000) - 120 }), /exp/);
  await expectFail(await sign(privateKey, { ...base, exp: '3h' }), /more than 3600 s/);
  await expectFail(await sign(privateKey, { ...base, jti: null }), /jti/);
  await expectFail(await sign(privateKey, { ...base, kid: 'nope' }), /no key in the client's JWKS matches kid "nope"/);
  await expectFail(await sign(other, base), /signature/);
  await expectFail(await sign(privateKey, { ...base, sub: 'someone-else' }), /iss and sub/);
  await expectFail(await sign(privateKey, base), /client_assertion_type/, { client_assertion_type: 'urn:wrong' });
  const once = await sign(privateKey, base);
  await token(once).expect(200);
  await expectFail(once, /already used/);
  // An HS256 assertion is client_secret_jwt, which this client is not registered for.
  await expectFail(await sign(new TextEncoder().encode('whatever'), { iss: 'neg-client', alg: 'HS256' }), /registered for private_key_jwt/);
  // A secret and an assertion together are refused.
  const both = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'client_credentials', client_assertion_type: BEARER, client_assertion: await sign(privateKey, base), client_secret: 'x' }).expect(400);
  assert.equal(both.body.error, 'invalid_request');
});

test('client_secret_jwt: HS256 over the client secret; the secret itself still works when the method is not pinned', async () => {
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'csj-client', secret: 'a-long-enough-shared-secret-for-hs256!' }).expect(201);
  const key = new TextEncoder().encode('a-long-enough-shared-secret-for-hs256!');
  await token(await sign(key, { iss: 'csj-client', alg: 'HS256' })).expect(200);
  await token(await sign(new TextEncoder().encode('wrong'), { iss: 'csj-client', alg: 'HS256' })).expect(401);
  await request(t.app).post('/oauth/token').auth('csj-client', 'a-long-enough-shared-secret-for-hs256!').type('form').send({ grant_type: 'client_credentials' }).expect(200);
  // Pinned to client_secret_jwt: Basic is refused.
  await request(t.app).patch('/admin/api/oauth/clients/csj-client').send({ tokenEndpointAuthMethod: 'client_secret_jwt' }).expect(200);
  const r = await request(t.app).post('/oauth/token').auth('csj-client', 'a-long-enough-shared-secret-for-hs256!').type('form').send({ grant_type: 'client_credentials' }).expect(401);
  assert.match(r.body.error_description, /signed JWT/);
});

test('dashboard helpers: generate a key pair, make an assertion, use it at the token endpoint and introspection', async () => {
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'helper-client', scopes: 'read write' }).expect(201);
  const kp = (await request(t.app).post('/admin/api/oauth/clients/helper-client/keypair').send({ alg: 'ES256' }).expect(201)).body;
  assert.match(kp.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.equal(kp.publicJwk.alg, 'ES256');
  const listed = (await request(t.app).get('/admin/api/auth').expect(200)).body.clients.find((c) => c.clientId === 'helper-client');
  assert.equal(listed.tokenEndpointAuthMethod, 'private_key_jwt');
  assert.equal(listed.jwks.keys[0].kid, kp.kid);
  const a = (await request(t.app).post('/admin/api/auth/client-assertion').send({ clientId: 'helper-client' }).expect(200)).body;
  assert.equal(a.method, 'private_key_jwt');
  assert.equal(a.decoded.header.kid, kp.kid);
  assert.equal(a.tokenEndpoint, AUD);
  const tok = (await token(a.assertion, { scope: 'read' }).expect(200)).body;
  // Introspection with another assertion (the audience may be the introspection endpoint itself).
  const b = (await request(t.app).post('/admin/api/auth/client-assertion').send({ clientId: 'helper-client', audience: 'http://localhost/oauth/introspect' }).expect(200)).body;
  const i = await request(t.app).post('/oauth/introspect').type('form').send({ token: tok.access_token, client_assertion_type: BEARER, client_assertion: b.assertion }).expect(200);
  assert.equal(i.body.active, true);
  // Inside a profile the token endpoint is the same server, so the root audience works there too.
  const c = (await request(t.app).post('/admin/api/auth/client-assertion').send({ clientId: 'helper-client' }).expect(200)).body;
  await request(t.app).post('/p/bearer/oauth/token').type('form').send({ grant_type: 'client_credentials', client_assertion_type: BEARER, client_assertion: c.assertion }).expect(200);
  // client_secret_jwt via the helper needs a secret, which a generated client still has.
  const s = (await request(t.app).post('/admin/api/auth/client-assertion').send({ clientId: 'helper-client', method: 'client_secret_jwt' }).expect(200)).body;
  assert.equal(s.decoded.header.alg, 'HS256');
  await request(t.app).post('/admin/api/auth/client-assertion').send({ clientId: 'helper-client', method: 'bogus' }).expect(400);
  await request(t.app).post('/admin/api/auth/client-assertion').send({ clientId: 'no-such' }).expect(404);
});

test('dynamic registration with jwks; jwks_uri needs https unless OAUTH_FETCH_PRIVATE', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const reg = (await request(t.app).post('/oauth/register').send({ client_name: 'jwt app', grant_types: ['client_credentials'], token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [publicKey.export({ format: 'jwk' })] }, scope: 'read' }).expect(201)).body;
  assert.equal(reg.token_endpoint_auth_method, 'private_key_jwt');
  assert.equal(reg.client_secret, undefined, 'no secret for private_key_jwt');
  assert.equal(reg.jwks.keys.length, 1);
  await token(await sign(privateKey, { iss: reg.client_id, alg: 'RS256' })).expect(200);
  const bad = await request(t.app).post('/oauth/register').send({ grant_types: ['client_credentials'], token_endpoint_auth_method: 'private_key_jwt' }).expect(400);
  assert.equal(bad.body.error, 'invalid_client_metadata');
  await request(t.app).post('/oauth/register').send({ grant_types: ['client_credentials'], token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'http://example.com/jwks.json' }).expect(400);
});

test('jwks_uri: fetched (and cached) through the guarded fetch; private addresses refused by default', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'remote' }] })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const uri = `http://127.0.0.1:${srv.address().port}/jwks.json`;
  try {
    await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'uri-client', jwksUri: uri, tokenEndpointAuthMethod: 'private_key_jwt' }).expect(201);
    const refused = await token(await sign(privateKey, { iss: 'uri-client', alg: 'ES256', kid: 'remote' })).expect(401);
    assert.match(refused.body.error_description, /http: URLs are not fetched|private or local/);
    await t.ctx.settings.set('oauthFetchPrivate', true);
    await token(await sign(privateKey, { iss: 'uri-client', alg: 'ES256', kid: 'remote' })).expect(200);
    await token(await sign(privateKey, { iss: 'uri-client', alg: 'ES256', kid: 'remote' })).expect(200);
    assert.equal(hits, 1, 'the JWKS is cached');
  } finally {
    await t.ctx.settings.set('oauthFetchPrivate', false);
    srv.close();
  }
});
