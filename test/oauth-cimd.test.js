'use strict';
// Client ID metadata documents (CIMD): an https URL as client_id. Hosted documents (/oauth/client-metadata/<name>.json),
// fetched documents (guarded fetch, cache), validation, the OAUTH_CIMD switch, private_key_jwt CIMD clients.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const request = require('supertest');
const jose = require('jose');
const { makeApp } = require('./helpers');

const DEMO = 'http://localhost/oauth/client-metadata/demo.json';
const REDIRECT = 'https://oauth.pstmn.io/v1/callback';
let t;
before(async () => { t = await makeApp({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.close(); });

const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };
function authorize(clientId, redirect, challenge) {
  return request(t.app).post('/oauth/authorize').type('form').send({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: 'read', state: 's', code_challenge: challenge, code_challenge_method: 'S256', username: 'demo', password: 'demo', decision: 'allow',
  });
}
async function withSettings(values, fn) {
  await t.ctx.settings.setMany(values);
  try { return await fn(); } finally { for (const key of Object.keys(values)) await t.ctx.settings.reset({ key }); }
}
// A client metadata document served from a local http server (needs OAUTH_FETCH_PRIVATE).
async function docServer(build, headers = {}) {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(build(`http://127.0.0.1:${srv.address().port}${req.url}`))); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: (p) => `http://127.0.0.1:${srv.address().port}${p}`, hits: () => hits, close: () => srv.close() };
}

test('discovery advertises CIMD; the switch removes it', async () => {
  const m = (await request(t.app).get('/.well-known/oauth-authorization-server').expect(200)).body;
  assert.equal(m.client_id_metadata_document_supported, true);
  await withSettings({ oauthCimd: false }, async () => {
    const off = (await request(t.app).get('/.well-known/oauth-authorization-server').expect(200)).body;
    assert.equal(off.client_id_metadata_document_supported, undefined);
  });
});

test('the hosted demo document: its client_id is its own URL', async () => {
  const d = (await request(t.app).get('/oauth/client-metadata/demo.json').expect(200)).body;
  assert.equal(d.client_id, DEMO);
  assert.equal(d.token_endpoint_auth_method, 'none');
  assert.ok(d.redirect_uris.includes(REDIRECT));
  await request(t.app).get('/oauth/client-metadata/nope.json').expect(404);
});

test('authorization code + PKCE and refresh with a URL client_id (no registration)', async () => {
  const page = await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: DEMO, redirect_uri: REDIRECT, scope: 'read' }).expect(200);
  assert.match(page.text, /CIMD demo client/);
  assert.match(page.text, /metadata document on <strong>localhost<\/strong> \(CIMD\), hosted by this server/);
  const { verifier, challenge } = pkce();
  const code = new URL((await authorize(DEMO, REDIRECT, challenge).expect(302)).headers.location).searchParams.get('code');
  const tok = (await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: DEMO, code_verifier: verifier }).expect(200)).body;
  assert.equal(jose.decodeJwt(tok.access_token).client_id, DEMO);
  const again = (await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: DEMO }).expect(200)).body;
  assert.ok(again.access_token);
  // Not in the document's redirect_uris.
  await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: DEMO, redirect_uri: 'https://evil.example/cb' }).expect(400);
  // A public CIMD client cannot use client_credentials.
  await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'client_credentials', client_id: DEMO }).expect(401);
  const seen = (await request(t.app).get('/admin/api/oauth/client-metadata').expect(200)).body.seen.find((s) => s.url === DEMO);
  assert.ok(seen.uses >= 3);
  assert.equal(seen.hostedHere, true);
});

test('OAUTH_CIMD=false refuses URL client_ids with a clear message', async () => {
  await withSettings({ oauthCimd: false }, async () => {
    const page = await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: DEMO, redirect_uri: REDIRECT }).expect(400);
    assert.match(page.text, /CIMD is turned off/);
  });
});

test('hosted documents can be added and edited; bad metadata is refused', async () => {
  const bad = await request(t.app).put('/admin/api/oauth/client-metadata/shop').send({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }).expect(400);
  assert.match(bad.body.detail, /none" or "private_key_jwt/);
  await request(t.app).put('/admin/api/oauth/client-metadata/shop').send({ redirect_uris: [REDIRECT], client_secret: 'x' }).expect(400);
  await request(t.app).put('/admin/api/oauth/client-metadata/shop').send({ grant_types: ['authorization_code'] }).expect(400);
  await request(t.app).put('/admin/api/oauth/client-metadata/Bad_Name').send({ redirect_uris: [REDIRECT] }).expect(400);
  const ok = (await request(t.app).put('/admin/api/oauth/client-metadata/shop').send({ client_id: 'ignored', client_name: 'Shop app', redirect_uris: ['https://shop.example/cb'], scope: 'read' }).expect(200)).body;
  assert.equal(ok.document.client_id, 'http://localhost/oauth/client-metadata/shop.json');
  const url = ok.url;
  await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: url, redirect_uri: 'https://shop.example/cb', scope: 'read' }).expect(200);
  // Edits apply at once (hosted documents are not cached).
  await request(t.app).put('/admin/api/oauth/client-metadata/shop').send({ client_name: 'Shop app', redirect_uris: ['https://shop.example/other'] }).expect(200);
  await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: url, redirect_uri: 'https://shop.example/cb' }).expect(400);
  const list = (await request(t.app).get('/admin/api/oauth/client-metadata').expect(200)).body;
  assert.deepEqual(list.documents.map((d) => d.name), ['demo', 'shop']);
  await request(t.app).delete('/admin/api/oauth/client-metadata/shop').expect(204);
  await request(t.app).delete('/admin/api/oauth/client-metadata/demo').expect(404);
  await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: url, redirect_uri: 'https://shop.example/other' }).expect(400);
});

test('fetched documents: private hosts refused by default, client_id must match, cached under max-age', async () => {
  const s = await docServer((self) => ({ client_id: self, client_name: 'Remote app', redirect_uris: ['http://127.0.0.1:9/cb'] }), { 'cache-control': 'max-age=120' });
  const wrong = await docServer(() => ({ client_id: 'https://someone-else.example/client.json', redirect_uris: ['http://127.0.0.1:9/cb'] }));
  try {
    const refused = await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: s.url('/client.json'), redirect_uri: 'http://127.0.0.1:9/cb' }).expect(400);
    assert.match(refused.text, /must use https/);
    await withSettings({ oauthFetchPrivate: true }, async () => {
      const page = await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: s.url('/client.json'), redirect_uri: 'http://127.0.0.1:9/cb' }).expect(200);
      assert.match(page.text, /Remote app/);
      await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: s.url('/client.json'), redirect_uri: 'http://127.0.0.1:9/cb' }).expect(200);
      assert.equal(s.hits(), 1, 'cached');
      const mism = await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: wrong.url('/client.json'), redirect_uri: 'http://127.0.0.1:9/cb' }).expect(400);
      assert.match(mism.text, /client_id must be exactly the document URL/);
      const seen = (await request(t.app).get('/admin/api/oauth/client-metadata').expect(200)).body.seen;
      assert.match(seen.find((x) => x.url === wrong.url('/client.json')).error, /exactly the document URL/);
    });
    // URL rules: a path, no fragment, no dot segments.
    for (const bad of ['https://client.example', 'https://client.example/a/../b.json', 'https://u:p@client.example/c.json']) {
      await request(t.app).get('/oauth/authorize').query({ response_type: 'code', client_id: bad, redirect_uri: REDIRECT }).expect(400);
    }
  } finally { s.close(); wrong.close(); }
});

test('a private_key_jwt CIMD client: client_credentials with an assertion whose iss is the URL', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const doc = (await request(t.app).put('/admin/api/oauth/client-metadata/agent').send({
    client_name: 'Agent', grant_types: ['client_credentials'], token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'a1' }] }, scope: 'read',
  }).expect(200)).body;
  const assertion = await new jose.SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'a1' }).setIssuer(doc.url).setSubject(doc.url)
    .setAudience('http://localhost/oauth/token').setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime('2m').sign(privateKey);
  const tok = (await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }).expect(200)).body;
  assert.equal(jose.decodeJwt(tok.access_token).client_id, doc.url);
  // Without keys, private_key_jwt is refused.
  await request(t.app).put('/admin/api/oauth/client-metadata/agent2').send({ grant_types: ['client_credentials'], token_endpoint_auth_method: 'private_key_jwt' }).expect(400);
});
