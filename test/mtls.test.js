'use strict';
// Mutual TLS: the lab CA (certificates and PKCS#12 checked by Node and, when present, openssl), the mTLS listener with
// AUTH_MODE=mtls (through /p/mtls), and RFC 8705: tls_client_auth, self_signed_tls_client_auth, certificate-bound tokens.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const request = require('supertest');
const jose = require('jose');
const { makeApp } = require('./helpers');
const { CaService } = require('../src/services/ca');

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
let t;
let tlsServer;
let port;
let lab; // a client certificate from the lab CA
let other; // a second one, from the same CA
let rogue; // self-signed: a CA nobody trusts (its own certificate is the client certificate)

before(async () => {
  t = await makeApp({ SEED_SAMPLE_FILES: 'false', MTLS_ENABLED: 'true' });
  tlsServer = await t.app.listenTls(0, '127.0.0.1');
  port = tlsServer.address().port;
  lab = (await request(t.app).post('/admin/api/mtls/certs').send({ cn: 'fusion-client', o: 'Acme', san: { uri: ['spiffe://lab/fusion'], dns: ['fusion.example'] } }).expect(201)).body;
  other = (await request(t.app).post('/admin/api/mtls/certs').send({ cn: 'other-client' }).expect(201)).body;
  const store = new Map();
  const r = new CaService({ repo: { get: async (c, id) => store.get(c + id), put: async (c, id, d) => store.set(c + id, d) } });
  await r.init();
  rogue = { certPem: r.caPem, keyPem: (await store.get('mtlsca')).keyPem };
});
after(async () => { await new Promise((r) => tlsServer.close(r)); await t.close(); });

// An HTTPS call to the mTLS listener that verifies the server certificate against the lab CA.
function call(p, { method = 'GET', cert, form, headers = {} } = {}) {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  return new Promise((resolve, reject) => {
    const rq = https.request({
      host: '127.0.0.1', port, path: p, method, ca: t.ctx.ca.caPem, servername: 'localhost', ...(cert ? { cert: cert.certPem, key: cert.keyPem } : {}),
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json; try { json = JSON.parse(data); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text: data, body: json }); });
    });
    rq.on('error', reject);
    rq.end(body);
  });
}
const thumb = (pem) => crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('base64url');

test('the lab CA issues client certificates; PEM and PKCS#12 downloads', async () => {
  const x = new crypto.X509Certificate(lab.certPem);
  assert.ok(x.verify(new crypto.X509Certificate(t.ctx.ca.caPem).publicKey), 'signed by the lab CA');
  assert.match(x.subjectAltName, /URI:spiffe:\/\/lab\/fusion/);
  assert.equal(lab['x5t#S256'], thumb(lab.certPem));
  const info = (await request(t.app).get('/admin/api/mtls').expect(200)).body;
  assert.equal(info.enabled, true);
  assert.equal(info.listening, true);
  assert.ok(info.certs.some((c) => c.id === lab.id && !c.keyPem), 'listing leaves out private keys');
  const ca = await request(t.app).get('/admin/api/mtls/ca.pem').expect(200);
  assert.match(ca.text, /BEGIN CERTIFICATE/);
  await request(t.app).get(`/admin/api/mtls/certs/${lab.id}/key.pem`).expect(200).expect(/PRIVATE KEY/);
  await request(t.app).post(`/admin/api/mtls/certs/${lab.id}/p12`).send({ password: 'x' }).expect(400);
  const p12 = await request(t.app).post(`/admin/api/mtls/certs/${lab.id}/p12`).send({ password: 'changeit' }).buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
  tls.createSecureContext({ pfx: p12.body, passphrase: 'changeit' }); // throws if Node/OpenSSL cannot read it
  assert.throws(() => tls.createSecureContext({ pfx: p12.body, passphrase: 'wrong' }));
  if (hasOpenssl) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-mtls-'));
    fs.writeFileSync(path.join(dir, 'ca.pem'), t.ctx.ca.caPem);
    fs.writeFileSync(path.join(dir, 'c.pem'), lab.certPem);
    fs.writeFileSync(path.join(dir, 'c.p12'), p12.body);
    assert.equal(spawnSync('openssl', ['verify', '-CAfile', 'ca.pem', 'c.pem'], { cwd: dir }).status, 0, 'openssl verify');
    assert.equal(spawnSync('openssl', ['pkcs12', '-in', 'c.p12', '-passin', 'pass:changeit', '-noout'], { cwd: dir }).status, 0, 'openssl reads the .p12 (MAC ok)');
  }
  await request(t.app).post('/admin/api/mtls/certs').send({ cn: '' }).expect(400);
  await request(t.app).post('/admin/api/mtls/certs').send({ cn: 'x', san: { uri: ['not a uri'] } }).expect(400);
});

test('AUTH_MODE=mtls through /p/mtls: no certificate, untrusted, trusted; links stay on the mTLS listener', async () => {
  const none = await call('/p/mtls/v1/employees?limit=1');
  assert.equal(none.status, 401);
  assert.equal(none.body.code, 'client-certificate-required');
  const bad = await call('/p/mtls/v1/employees?limit=1', { cert: rogue });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, 'client-certificate-untrusted');
  const ok = await call('/p/mtls/v1/p/link/employees?limit=1', { cert: lab });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.link, new RegExp(`https://127\\.0\\.0\\.1:${port}/p/mtls/v1/p/link/employees`));
  // On the plain listener the error says where to go.
  const plain = await request(t.app).get('/p/mtls/v1/employees?limit=1').expect(401);
  assert.match(plain.body.detail, /mTLS endpoint https:\/\//);
  // A profile that only accepts one subject.
  await request(t.app).post('/admin/api/profiles').send({ name: 'mtls-fusion', settings: { authMode: 'mtls', mtlsAllowedSubjects: 'spiffe://lab/fusion' } }).expect(201);
  assert.equal((await call('/p/mtls-fusion/v1/employees?limit=1', { cert: lab })).status, 200);
  const no = await call('/p/mtls-fusion/v1/employees?limit=1', { cert: other });
  assert.equal(no.status, 403);
  assert.equal(no.body.code, 'client-certificate-not-allowed');
});

test('discovery advertises RFC 8705 on the mTLS endpoints', async () => {
  const m = (await request(t.app).get('/.well-known/oauth-authorization-server').expect(200)).body;
  assert.equal(m.tls_client_certificate_bound_access_tokens, true);
  assert.match(m.mtls_endpoint_aliases.token_endpoint, /^https:\/\/localhost:8443\/oauth\/token$/);
  assert.ok(m.token_endpoint_auth_methods_supported.includes('tls_client_auth'));
  assert.ok(m.token_endpoint_auth_methods_supported.includes('self_signed_tls_client_auth'));
  assert.equal(m.issuer, 'http://localhost', 'one issuer for both listeners');
});

test('tls_client_auth by subject DN and by SAN URI; tokens bound to the certificate', async () => {
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'tls-dn', scopes: 'read write', tokenEndpointAuthMethod: 'tls_client_auth', tlsClientAuth: { type: 'subject_dn', value: 'CN=fusion-client, O=Acme' } }).expect(201);
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'tls-san', scopes: 'read', tokenEndpointAuthMethod: 'tls_client_auth', tlsClientAuth: { type: 'san_uri', value: 'spiffe://lab/fusion' } }).expect(201);
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'tls-x', tokenEndpointAuthMethod: 'tls_client_auth' }).expect(400);
  const tok = await call('/oauth/token', { method: 'POST', cert: lab, form: { grant_type: 'client_credentials', client_id: 'tls-dn' } });
  assert.equal(tok.status, 200, tok.text);
  const claims = jose.decodeJwt(tok.body.access_token);
  assert.equal(claims.cnf['x5t#S256'], thumb(lab.certPem));
  assert.equal(claims.iss, 'http://localhost');
  assert.equal((await call('/oauth/token', { method: 'POST', cert: lab, form: { grant_type: 'client_credentials', client_id: 'tls-san' } })).status, 200);
  const wrong = await call('/oauth/token', { method: 'POST', cert: other, form: { grant_type: 'client_credentials', client_id: 'tls-dn' } });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error_description, /does not match/);
  const plain = await request(t.app).post('/oauth/token').type('form').send({ grant_type: 'client_credentials', client_id: 'tls-dn' }).expect(401);
  assert.match(plain.body.error_description, /mTLS listener/);
  // The bound token: works with the same certificate on the mTLS listener, nowhere else.
  const auth = { Authorization: `Bearer ${tok.body.access_token}` };
  assert.equal((await call('/p/oauth2/v1/employees?limit=1', { cert: lab, headers: auth })).status, 200);
  const otherCert = await call('/p/oauth2/v1/employees?limit=1', { cert: other, headers: auth });
  assert.equal(otherCert.status, 401);
  assert.equal(otherCert.body.code, 'certificate-mismatch');
  const r = await request(t.app).get('/p/oauth2/v1/employees?limit=1').set(auth).expect(401);
  assert.match(r.body.detail, /bound to a client certificate/);
  // Introspection shows the binding.
  const i = await call('/oauth/introspect', { method: 'POST', cert: lab, form: { token: tok.body.access_token, client_id: 'tls-dn' } });
  assert.equal(i.body.active, true);
  assert.equal(i.body.cnf['x5t#S256'], thumb(lab.certPem));
  // A token from the plain listener (no certificate) is not bound and works on both.
  const unbound = (await request(t.app).post('/oauth/token').auth('demo-client', 'demo-secret').type('form').send({ grant_type: 'client_credentials' }).expect(200)).body;
  assert.equal(jose.decodeJwt(unbound.access_token).cnf, undefined);
  assert.equal((await call('/p/oauth2/v1/employees?limit=1', { headers: { Authorization: `Bearer ${unbound.access_token}` } })).status, 200);
});

test('self_signed_tls_client_auth: the certificate registered in the client\'s jwks', async () => {
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'tls-self', scopes: 'read', tokenEndpointAuthMethod: 'self_signed_tls_client_auth', jwks: rogue.certPem }).expect(201);
  const tok = await call('/oauth/token', { method: 'POST', cert: rogue, form: { grant_type: 'client_credentials', client_id: 'tls-self' } });
  assert.equal(tok.status, 200, tok.text);
  assert.equal(jose.decodeJwt(tok.body.access_token).cnf['x5t#S256'], thumb(rogue.certPem));
  const no = await call('/oauth/token', { method: 'POST', cert: lab, form: { grant_type: 'client_credentials', client_id: 'tls-self' } });
  assert.equal(no.status, 401);
  await request(t.app).post('/admin/api/oauth/clients').send({ clientId: 'tls-self2', tokenEndpointAuthMethod: 'self_signed_tls_client_auth' }).expect(400);
});

test('dynamic registration of tls_client_auth clients', async () => {
  const reg = (await request(t.app).post('/oauth/register').send({ grant_types: ['client_credentials'], token_endpoint_auth_method: 'tls_client_auth', tls_client_auth_san_dns: 'fusion.example', scope: 'read' }).expect(201)).body;
  assert.equal(reg.client_secret, undefined);
  assert.equal(reg.tls_client_auth_san_dns, 'fusion.example');
  assert.equal((await call('/oauth/token', { method: 'POST', cert: lab, form: { grant_type: 'client_credentials', client_id: reg.client_id } })).status, 200);
  const bad = await request(t.app).post('/oauth/register').send({ grant_types: ['client_credentials'], token_endpoint_auth_method: 'tls_client_auth' }).expect(400);
  assert.equal(bad.body.error, 'invalid_client_metadata');
});
