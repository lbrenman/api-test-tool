'use strict';
// Generates postman/API-Test-Tool.postman_collection.json and the environment file.
// Run: npm run postman:build   (the generated JSON is committed so Postman users don't need Node)
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '../postman');
let seq = 0;
const id = () => `att-${(++seq).toString(36).padStart(4, '0')}`;

function url(raw) {
  const [p, q] = raw.split('?');
  const out = { raw: `{{baseUrl}}${raw}`, host: ['{{baseUrl}}'], path: p.split('/').filter(Boolean) };
  if (q) out.query = q.split('&').map((kv) => { const i = kv.indexOf('='); return { key: i < 0 ? kv : kv.slice(0, i), value: i < 0 ? '' : kv.slice(i + 1) }; });
  return out;
}

function req(name, method, raw, { headers = {}, body, tests = [], pre = [], description } = {}) {
  const item = {
    id: id(),
    name,
    request: {
      method,
      header: Object.entries(headers).map(([key, value]) => ({ key, value })),
      url: raw.startsWith('{{') ? { raw, host: [raw] } : url(raw),
      ...(description ? { description } : {}),
    },
    event: [],
  };
  if (body) item.request.body = body;
  if (pre.length) item.event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } });
  if (tests.length) item.event.push({ listen: 'test', script: { type: 'text/javascript', exec: tests } });
  return item;
}

const json = (obj) => ({ mode: 'raw', raw: JSON.stringify(obj, null, 2), options: { raw: { language: 'json' } } });
const rawText = (text) => ({ mode: 'raw', raw: text });
const folder = (name, items, description) => ({ id: id(), name, item: items, ...(description ? { description } : {}) });
const status = (code) => `pm.test('status ${code}', () => pm.response.to.have.status(${code}));`;
const problem = (code) => [status(code), "pm.test('problem+json', () => pm.expect(pm.response.headers.get('Content-Type')).to.include('application/problem+json'));", `pm.test('problem status field', () => pm.expect(pm.response.json().status).to.eql(${code}));`];

// ---------------------------------------------------------------- collection-level scripts
const collectionPreBody = [
  "const sdk = require('postman-collection');",
  "const CryptoJS = require('crypto-js');",
  "const mode = pm.environment.get('authMode') || pm.collectionVariables.get('authMode') || 'none';",
  "const skip = pm.request.headers.has('X-Skip-Auth');",
  "if (skip) pm.request.headers.remove('X-Skip-Auth');",
  "const resolved = new sdk.Url(pm.variables.replaceIn(pm.request.url.toString()));",
  "const p = resolved.getPath().replace(/^\\/p\\/[^/]+(?=\\/)/, ''); // a settings profile prefix (/p/<name>) is not part of the API path",
  "const isApi = (p.indexOf('/v1/') === 0 && p.indexOf('/v1/files/presigned/') !== 0) || (p.indexOf('/soap/') === 0 && pm.request.method === 'POST') || p.indexOf('/sse/') === 0 || p.indexOf('/llm/v1/') === 0 || p === '/mcp' || ((p === '/a2a' || p.indexOf('/a2a/') === 0) && p.indexOf('agent-card.json') < 0) || p === '/graphql' || (p.indexOf('/odata/v4/') === 0 && p !== '/odata/v4/' && p !== '/odata/v4/$metadata');",
  "if (!isApi || skip || mode === 'none') return;",
  "const set = (k, v) => pm.request.headers.upsert({ key: k, value: v });",
  "if (mode === 'apikey') {",
  "  const name = pm.environment.get('apiKeyName') || 'X-API-Key';",
  "  if ((pm.environment.get('apiKeyIn') || 'header') === 'query') pm.request.url.addQueryParams([{ key: name, value: pm.environment.get('apiKey') }]);",
  "  else set(name, pm.environment.get('apiKey'));",
  "} else if (mode === 'basic') {",
  "  set('Authorization', 'Basic ' + CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(pm.environment.get('basicUser') + ':' + pm.environment.get('basicPass'))));",
  "} else if (mode === 'bearer') {",
  "  set('Authorization', 'Bearer ' + pm.environment.get('bearerToken'));",
  "} else if (mode === 'jwt' || mode === 'oauth2') {",
  "  const cached = pm.collectionVariables.get('cachedToken');",
  "  const exp = Number(pm.collectionVariables.get('cachedTokenExp') || 0);",
  "  if (cached && exp > Date.now() + 15000) { set('Authorization', 'Bearer ' + cached); return; }",
  "  pm.sendRequest({",
  "    url: pm.environment.get('baseUrl') + '/oauth/token', method: 'POST',",
  "    header: [{ key: 'Authorization', value: 'Basic ' + CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(pm.environment.get('clientId') + ':' + pm.environment.get('clientSecret'))) }],",
  "    body: { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'scope', value: pm.environment.get('scope') || 'read write' }] },",
  "  }, (err, res) => {",
  "    if (err || res.code !== 200) { console.error('token request failed', err || res.text()); return; }",
  "    const tok = res.json();",
  "    pm.collectionVariables.set('cachedToken', tok.access_token);",
  "    pm.collectionVariables.set('cachedTokenExp', String(Date.now() + tok.expires_in * 1000));",
  "    set('Authorization', 'Bearer ' + tok.access_token);",
  "  });",
  "} else if (mode === 'hmac') {",
  "  const pathQuery = resolved.getPathWithQuery();",
  "  const ts = String(Math.floor(Date.now() / 1000));",
  "  const b = pm.request.body;",
  "  let bodyHash;",
  "  const streamed = p.indexOf('/v1/files/') === 0 && p !== '/v1/files/base64' && p !== '/v1/files/presign';",
  "  if (!b || b.isEmpty() || (b.mode === 'raw' && !b.raw)) bodyHash = CryptoJS.SHA256('').toString(CryptoJS.enc.Hex);",
  "  else if (streamed || b.mode !== 'raw') bodyHash = 'UNSIGNED-PAYLOAD';",
  "  else bodyHash = CryptoJS.SHA256(CryptoJS.enc.Utf8.parse(pm.variables.replaceIn(b.raw))).toString(CryptoJS.enc.Hex);",
  "  const canonical = [pm.request.method.toUpperCase(), pathQuery, ts, bodyHash].join('\\n');",
  "  const sig = CryptoJS.HmacSHA256(canonical, pm.environment.get('hmacSecret')).toString(CryptoJS.enc.Base64);",
  "  set('Authorization', 'HMAC ' + pm.environment.get('hmacKeyId') + ':' + sig);",
  "  set('X-Timestamp', ts);",
  "}",
];
// The sandbox does not allow top-level return, so the body runs inside a function.
const collectionPre = [
  '// Applies the auth mode in {{authMode}} to /v1 requests, SOAP POSTs, SSE streams, /graphql, OData, the mock LLM, /mcp and /a2a. Requests with header X-Skip-Auth: 1 go out unauthenticated.',
  '(function applyAuth() {',
  ...collectionPreBody.map((l) => `  ${l}`),
  '})();',
];

const collectionTest = [
  "if (pm.response.code !== 304 && pm.response.code !== 204) {",
  "  pm.test('[global] X-Request-Id present', () => pm.expect(pm.response.headers.get('X-Request-Id')).to.be.a('string'));",
  "}",
];

// ---------------------------------------------------------------- folders
const platform = folder('Platform', [
  req('Health', 'GET', '/health', { tests: [status(200), "pm.test('ok', () => pm.expect(pm.response.json().status).to.eql('ok'));", "pm.environment.set('totalEmployees', pm.response.json().data.employees); pm.environment.set('totalProducts', pm.response.json().data.products);"] }),
  req('Ready', 'GET', '/ready', { tests: [status(200)] }),
  req('OpenAPI JSON', 'GET', '/openapi.json', { tests: [status(200), "pm.test('3.1', () => pm.expect(pm.response.json().openapi).to.eql('3.1.0'));", "pm.test('auth mode reflected', () => { const s = pm.response.json().components.securitySchemes; const m = pm.environment.get('authMode'); if (m === 'none') pm.expect(Object.keys(s)).to.have.length(0); else pm.expect(Object.keys(s)).to.have.length(1); });", "pm.test('data API only (no admin or health paths)', () => pm.expect(Object.keys(pm.response.json().paths).filter((p) => !p.startsWith('/v1/') && !p.startsWith('/oauth/') && !p.startsWith('/sse/') && !p.startsWith('/llm/'))).to.have.length(0));"] }),
  req('OpenAPI YAML', 'GET', '/openapi.yaml', { tests: [status(200), "pm.test('yaml', () => pm.expect(pm.response.text()).to.include('openapi: 3.1.0'));"] }),
  req('OpenAPI JSON (admin API)', 'GET', '/admin/api/openapi.json', {
    description: 'The admin / control-plane spec. Needs the dashboard password when ADMIN_PASSWORD is set (401 otherwise).',
    tests: [
      "const inProfile = /\\/p\\/[^/]+\\/?$/.test(pm.environment.get('baseUrl'));",
      "pm.test('200 or 401 (password set); 404 inside a settings profile', () => pm.expect(inProfile ? [404] : [200, 401]).to.include(pm.response.code));",
      "if (pm.response.code === 200) {",
      "  const d = pm.response.json();",
      "  pm.test('admin spec', () => pm.expect(d.info.title).to.include('Admin API'));",
      "  pm.test('no /v1 paths', () => pm.expect(Object.keys(d.paths).filter((p) => p.startsWith('/v1'))).to.have.length(0));",
      "  pm.test('health documented here', () => pm.expect(d.paths).to.have.property('/health'));",
      "}",
    ],
  }),
  req('JWKS', 'GET', '/.well-known/jwks.json', { tests: [status(200), "pm.test('RSA key', () => pm.expect(pm.response.json().keys[0].kty).to.eql('RSA'));"] }),
  req('OAuth metadata (RFC 8414)', 'GET', '/.well-known/oauth-authorization-server', { tests: [status(200), "pm.test('token endpoint', () => pm.expect(pm.response.json().token_endpoint).to.include('/oauth/token'));"] }),
]);

const basicAuth = '{{clientId}}';
const ccBody = { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'scope', value: 'read write' }] };
const clientAuth = { type: 'basic', basic: [{ key: 'username', value: basicAuth }, { key: 'password', value: '{{clientSecret}}' }] };
const withAuth = (item, auth) => { item.request.auth = auth; return item; };

const oauth = folder('OAuth server', [
  withAuth(req('Token — client_credentials', 'POST', '/oauth/token', { body: ccBody, tests: [status(200), "const t = pm.response.json(); pm.test('bearer token', () => { pm.expect(t.token_type).to.eql('Bearer'); pm.expect(t.access_token.split('.')).to.have.length(3); });", "pm.environment.set('oauthToken', t.access_token);"] }), clientAuth),
  withAuth(req('Introspect — active', 'POST', '/oauth/introspect', { body: { mode: 'urlencoded', urlencoded: [{ key: 'token', value: '{{oauthToken}}' }] }, tests: [status(200), "pm.test('active', () => pm.expect(pm.response.json().active).to.eql(true));", "pm.test('client', () => pm.expect(pm.response.json().client_id).to.eql(pm.environment.get('clientId')));"] }), clientAuth),
  withAuth(req('Revoke', 'POST', '/oauth/revoke', { body: { mode: 'urlencoded', urlencoded: [{ key: 'token', value: '{{oauthToken}}' }] }, tests: [status(200)] }), clientAuth),
  withAuth(req('Introspect — revoked', 'POST', '/oauth/introspect', { body: { mode: 'urlencoded', urlencoded: [{ key: 'token', value: '{{oauthToken}}' }] }, tests: [status(200), "pm.test('inactive', () => pm.expect(pm.response.json().active).to.eql(false));"] }), clientAuth),
  withAuth(req('Token — bad secret → 401', 'POST', '/oauth/token', { body: ccBody, tests: [status(401), "pm.test('invalid_client', () => pm.expect(pm.response.json().error).to.eql('invalid_client'));"] }), { type: 'basic', basic: [{ key: 'username', value: basicAuth }, { key: 'password', value: 'wrong' }] }),
  withAuth(req('Token — invalid scope → 400', 'POST', '/oauth/token', { body: { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'scope', value: 'admin' }] }, tests: [status(400), "pm.test('invalid_scope', () => pm.expect(pm.response.json().error).to.eql('invalid_scope'));"] }), clientAuth),
  req('Discovery advertises registration', 'GET', '/.well-known/oauth-authorization-server', { tests: [status(200), "pm.test('registration_endpoint', () => pm.expect(pm.response.json().registration_endpoint).to.match(/\\/oauth\\/register$/));"] }),
  req('Register a public client the way MCP clients do (RFC 7591)', 'POST', '/oauth/register', { headers: { 'Content-Type': 'application/json' }, body: json({ client_name: 'Postman', redirect_uris: ['http://127.0.0.1:33418/callback'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', scope: 'read' }), tests: [status(201), "const c = pm.response.json(); pm.test('client issued', () => { pm.expect(c.client_id).to.match(/^dcr-/); pm.expect(c.client_secret).to.eql(undefined); pm.expect(c.token_endpoint_auth_method).to.eql('none'); pm.expect(c.scope).to.eql('read'); pm.expect(c.registration_access_token).to.be.a('string'); });", "pm.test('Location', () => pm.expect(pm.response.headers.get('Location')).to.eql(c.registration_client_uri));", "pm.environment.set('dcrId', c.client_id); pm.environment.set('dcrRegToken', c.registration_access_token); pm.environment.set('dcrUri', c.registration_client_uri);"] }),
  req('Register a machine client (client_credentials)', 'POST', '/oauth/register', { headers: { 'Content-Type': 'application/json' }, body: json({ client_name: 'Postman machine', grant_types: ['client_credentials'], scope: 'read' }), tests: [status(201), "const c = pm.response.json(); pm.test('secret issued', () => pm.expect(c.client_secret).to.be.a('string')); pm.environment.set('dcrCcId', c.client_id); pm.environment.set('dcrCcSecret', c.client_secret);"] }),
  withAuth(req('Token for the machine client', 'POST', '/oauth/token', { body: { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }] }, tests: [status(200), "pm.test('read only', () => pm.expect(pm.response.json().scope).to.eql('read'));"] }), { type: 'basic', basic: [{ key: 'username', value: '{{dcrCcId}}' }, { key: 'password', value: '{{dcrCcSecret}}' }] }),
  req('Open registration refuses a plain http redirect → 400', 'POST', '/oauth/register', { headers: { 'Content-Type': 'application/json' }, body: json({ redirect_uris: ['http://evil.example/cb'], token_endpoint_auth_method: 'none' }), tests: [status(400), "pm.test('invalid_redirect_uri', () => pm.expect(pm.response.json().error).to.eql('invalid_redirect_uri'));"] }),
  req('Read the registration (RFC 7592)', 'GET', '{{dcrUri}}', { headers: { Authorization: 'Bearer {{dcrRegToken}}' }, tests: [status(200), "pm.test('same client', () => pm.expect(pm.response.json().client_id).to.eql(pm.environment.get('dcrId')));"] }),
  req('Read with a wrong token → 401', 'GET', '{{dcrUri}}', { headers: { Authorization: 'Bearer wrong' }, tests: [status(401), "pm.test('invalid_token', () => pm.expect(pm.response.json().error).to.eql('invalid_token'));"] }),
  req('Delete the registration', 'DELETE', '{{dcrUri}}', { headers: { Authorization: 'Bearer {{dcrRegToken}}' }, tests: [status(204)] }),
  req('Authorize after delete → 400', 'GET', '/oauth/authorize?response_type=code&client_id={{dcrId}}&redirect_uri=http://127.0.0.1:33418/callback', { tests: [status(400)] }),
  req('Register without redirect_uris → 400', 'POST', '/oauth/register', { headers: { 'Content-Type': 'application/json' }, body: json({ grant_types: ['authorization_code'] }), tests: [status(400), "pm.test('invalid_redirect_uri', () => pm.expect(pm.response.json().error).to.eql('invalid_redirect_uri'));"] }),
]);

// RFC 7523 client authentication. client_secret_jwt is signed in the pre-request script (HS256 with CryptoJS);
// Postman's sandbox cannot sign RS256/ES256, so private_key_jwt uses the admin helper (skipped when the admin API needs a password).
const BEARER_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const assertionBody = (extra = []) => ({ mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'client_assertion_type', value: BEARER_TYPE }, { key: 'client_assertion', value: '{{clientAssertion}}' }, ...extra] });
const signHs256 = (aud) => [
  "const CJ = require('crypto-js');",
  "const b64 = (w) => CJ.enc.Base64.stringify(w).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');",
  "const now = Math.floor(Date.now() / 1000);",
  "const id = pm.environment.get('clientId');",
  `const claims = { iss: id, sub: id, aud: ${aud}, iat: now, exp: now + 300, jti: pm.variables.replaceIn('{{$guid}}') };`,
  "const input = b64(CJ.enc.Utf8.parse(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))) + '.' + b64(CJ.enc.Utf8.parse(JSON.stringify(claims)));",
  "pm.environment.set('clientAssertion', input + '.' + b64(CJ.HmacSHA256(input, pm.environment.get('clientSecret'))));",
];
const adminOnly = ["if (pm.environment.get('adminOpen') !== 'yes') pm.execution.skipRequest();"];
const assertions = folder('Client assertions (RFC 7523)', [
  req('Discovery advertises private_key_jwt and client_secret_jwt', 'GET', '/.well-known/oauth-authorization-server', {
    pre: ["pm.environment.set('rootUrl', pm.environment.get('baseUrl').replace(/\\/p\\/[^/]+\\/?$/, '')); // admin API and OAuth server live at the root"],
    tests: [status(200), "const m = pm.response.json();", "pm.test('methods', () => pm.expect(m.token_endpoint_auth_methods_supported).to.include.members(['client_secret_jwt', 'private_key_jwt']));", "pm.test('algs', () => pm.expect(m.token_endpoint_auth_signing_alg_values_supported).to.include.members(['RS256', 'ES256', 'HS256']));"],
  }),
  req('client_secret_jwt — HS256 assertion signed in the pre-request script', 'POST', '/oauth/token', { body: assertionBody(), pre: signHs256("pm.environment.get('baseUrl') + '/oauth/token'"), tests: [status(200), "pm.test('token for the client', () => pm.expect(JSON.parse(atob(pm.response.json().access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).client_id).to.eql(pm.environment.get('clientId')));"] }),
  req('Replay the same assertion → 401', 'POST', '/oauth/token', { body: assertionBody(), tests: [status(401), "pm.test('jti already used', () => { pm.expect(pm.response.json().error).to.eql('invalid_client'); pm.expect(pm.response.json().error_description).to.match(/already used/); });"] }),
  req('Wrong audience → 401', 'POST', '/oauth/token', { body: assertionBody(), pre: signHs256("'https://elsewhere.example/token'"), tests: [status(401), "pm.test('aud named', () => pm.expect(pm.response.json().error_description).to.match(/aud must be one of/));"] }),
  req('Assertion plus a client secret → 400', 'POST', '/oauth/token', { body: assertionBody([{ key: 'client_secret', value: '{{clientSecret}}' }]), pre: signHs256("pm.environment.get('baseUrl') + '/oauth/token'"), tests: [status(400), "pm.test('invalid_request', () => pm.expect(pm.response.json().error).to.eql('invalid_request'));"] }),
  req('Add a client for private_key_jwt (admin API)', 'POST', '{{rootUrl}}/admin/api/oauth/clients', {
    headers: { 'Content-Type': 'application/json' }, body: json({ clientId: 'postman-pkj', scopes: 'read' }),
    description: 'Needs the admin API: when ADMIN_PASSWORD is set this returns 401 and the private_key_jwt requests below are skipped.',
    tests: ["pm.test('201, or 401 when the admin API needs a password', () => pm.expect([201, 401]).to.include(pm.response.code));", "pm.environment.set('adminOpen', pm.response.code === 201 ? 'yes' : 'no');", "if (pm.response.code === 201) pm.environment.set('pkjSecret', pm.response.json().secret);"],
  }),
  req('Generate its key pair (ES256)', 'POST', '{{rootUrl}}/admin/api/oauth/clients/postman-pkj/keypair', { headers: { 'Content-Type': 'application/json' }, body: json({ alg: 'ES256' }), pre: adminOnly, tests: [status(201), "const k = pm.response.json();", "pm.test('public JWK and private key', () => { pm.expect(k.publicJwk.kty).to.eql('EC'); pm.expect(k.publicJwk.d).to.eql(undefined); pm.expect(k.privateKeyPem).to.include('PRIVATE KEY'); });", "pm.environment.set('pkjKid', k.kid);"] }),
  req('Server-signed assertion (admin helper)', 'POST', '{{rootUrl}}/admin/api/auth/client-assertion', { headers: { 'Content-Type': 'application/json' }, body: json({ clientId: 'postman-pkj', audience: '{{baseUrl}}/oauth/token' }), pre: adminOnly, tests: [status(200), "const a = pm.response.json();", "pm.test('private_key_jwt, ES256, our kid', () => { pm.expect(a.method).to.eql('private_key_jwt'); pm.expect(a.decoded.header.alg).to.eql('ES256'); pm.expect(a.decoded.header.kid).to.eql(pm.environment.get('pkjKid')); });", "pm.environment.set('clientAssertion', a.assertion);"] }),
  req('private_key_jwt — token with the assertion', 'POST', '/oauth/token', { body: assertionBody(), pre: adminOnly, tests: [status(200), "pm.test('read scope', () => pm.expect(pm.response.json().scope).to.eql('read'));"] }),
  withAuth(req('Its secret no longer works (pinned to private_key_jwt) → 401', 'POST', '/oauth/token', { body: { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }] }, pre: adminOnly, tests: [status(401), "pm.test('names the method', () => pm.expect(pm.response.json().error_description).to.match(/signed JWT/));"] }), { type: 'basic', basic: [{ key: 'username', value: 'postman-pkj' }, { key: 'password', value: '{{pkjSecret}}' }] }),
  req('Delete the client', 'DELETE', '{{rootUrl}}/admin/api/oauth/clients/postman-pkj', { pre: adminOnly, tests: [status(204)] }),
], 'Client authentication with signed JWTs instead of a secret on the wire: client_secret_jwt (HS256 over the secret) and private_key_jwt (the client\'s key pair).');

const authFolder = folder('Auth mode', [
  req('Without credentials', 'GET', '/v1/employees/1', { headers: { 'X-Skip-Auth': '1' }, tests: ["const m = pm.environment.get('authMode');", "pm.test('401 unless auth mode is none', () => pm.response.to.have.status(m === 'none' ? 200 : 401));", "if (m !== 'none') pm.test('WWW-Authenticate', () => pm.expect(pm.response.headers.get('WWW-Authenticate')).to.be.a('string'));"] }),
  req('With credentials', 'GET', '/v1/employees/1', { tests: [status(200)] }),
], 'The collection pre-request script authenticates /v1 calls according to {{authMode}}.');

const crud = folder('Employees CRUD', [
  req('Create (201 + Location + ETag)', 'POST', '/v1/employees', {
    headers: { 'Content-Type': 'application/json' },
    body: json({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', departmentId: 1, title: 'Engineer', level: 'L5', salary: 150000.5, skills: ['math', 'engines'], address: { city: 'London', countryCode: 'GB' }, metadata: { source: 'postman' } }),
    tests: [status(201), "pm.test('Location', () => pm.expect(pm.response.headers.get('Location')).to.match(/\\/v1\\/employees\\/\\d+$/));", "pm.test('salaryDecimal', () => pm.expect(pm.response.json().salaryDecimal).to.eql('150000.50'));", "pm.environment.set('employeeId', pm.response.json().id); pm.environment.set('employeeEtag', pm.response.headers.get('ETag'));"],
  }),
  req('Get (ETag)', 'GET', '/v1/employees/{{employeeId}}', { tests: [status(200), "pm.test('ETag', () => pm.expect(pm.response.headers.get('ETag')).to.be.a('string'));", "pm.environment.set('employeeEtag', pm.response.headers.get('ETag'));", "pm.test('nested department', () => pm.expect(pm.response.json().department.id).to.eql(1));"] }),
  req('Get with If-None-Match → 304', 'GET', '/v1/employees/{{employeeId}}', { headers: { 'If-None-Match': '{{employeeEtag}}' }, tests: [status(304)] }),
  req('Patch with stale If-Match → 412', 'PATCH', '/v1/employees/{{employeeId}}', { headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': '"stale"' }, body: rawText('{"title":"Nope"}'), tests: problem(412) }),
  req('Patch (merge patch, If-Match)', 'PATCH', '/v1/employees/{{employeeId}}', { headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': '{{employeeEtag}}' }, body: rawText('{"title":"Analytical Engineer","performanceRating":null}'), tests: [status(200), "pm.test('patched', () => { pm.expect(pm.response.json().title).to.eql('Analytical Engineer'); pm.expect(pm.response.json().performanceRating).to.eql(null); });"] }),
  req('Put (full replace)', 'PUT', '/v1/employees/{{employeeId}}', { headers: { 'Content-Type': 'application/json' }, body: json({ firstName: 'Augusta', lastName: 'King', email: 'augusta@example.com', departmentId: 2 }), tests: [status(200), "pm.test('replaced', () => { pm.expect(pm.response.json().firstName).to.eql('Augusta'); pm.expect(pm.response.json().title).to.eql(''); });"] }),
  req('Create with Idempotency-Key', 'POST', '/v1/departments', { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '{{idemKey}}' }, body: json({ name: 'Postman Dept', code: 'PMD' }), pre: ["pm.environment.set('idemKey', pm.variables.replaceIn('{{$guid}}'));"], tests: [status(201), "pm.environment.set('idemDeptId', pm.response.json().id);"] }),
  req('Replay same key → original response', 'POST', '/v1/departments', { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '{{idemKey}}' }, body: json({ name: 'Postman Dept', code: 'PMD' }), tests: [status(201), "pm.test('replayed', () => pm.expect(pm.response.headers.get('Idempotent-Replayed')).to.eql('true'));", "pm.test('same id', () => pm.expect(pm.response.json().id).to.eql(pm.environment.get('idemDeptId')));"] }),
  req('Same key, different body → 409', 'POST', '/v1/departments', { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '{{idemKey}}' }, body: json({ name: 'Different', code: 'DIF' }), tests: problem(409) }),
  req('Validation → 422', 'POST', '/v1/employees', { headers: { 'Content-Type': 'application/json' }, body: json({ firstName: 'X', email: 'not-an-email', departmentId: 1 }), tests: [...problem(422), "pm.test('field errors', () => pm.expect(pm.response.json().errors.map(e => e.field)).to.include.members(['lastName', 'email']));"] }),
  req('Malformed JSON → 400', 'POST', '/v1/employees', { headers: { 'Content-Type': 'application/json' }, body: rawText('{"firstName":'), tests: problem(400) }),
  req('Delete → 204', 'DELETE', '/v1/employees/{{employeeId}}', { tests: [status(204)] }),
  req('Get deleted → 404', 'GET', '/v1/employees/{{employeeId}}', { tests: problem(404) }),
  req('Delete department in use → 409', 'DELETE', '/v1/departments/1', { tests: problem(409) }),
  req('Nested: department employees', 'GET', '/v1/departments/1/employees?limit=200', { tests: [status(200), "pm.test('all in dept 1', () => pm.response.json().data.forEach(e => pm.expect(e.departmentId).to.eql(1)));"] }),
  req('Nested: category products', 'GET', '/v1/categories/1/products?limit=5', { tests: [status(200), "pm.test('all in cat 1', () => pm.response.json().data.forEach(p => pm.expect(p.categoryId).to.eql(1)));"] }),
]);

const query = folder('Query: fields / filter / sort', [
  req('Sparse fieldset', 'GET', '/v1/employees?fields=id,firstName,department.name&limit=3', { tests: [status(200), "pm.test('only requested fields', () => pm.expect(Object.keys(pm.response.json().data[0]).sort()).to.eql(['department', 'firstName', 'id']));"] }),
  req('Range filter + sort', 'GET', '/v1/products?price[gte]=100&price[lt]=500&sort=-price&limit=50', { tests: [status(200), "const d = pm.response.json().data;", "pm.test('in range', () => d.forEach(p => pm.expect(p.price).to.be.within(100, 499.999)));", "pm.test('sorted desc', () => { for (let i = 1; i < d.length; i++) pm.expect(d[i - 1].price).to.be.at.least(d[i].price); });"] }),
  req('Equality / list filter', 'GET', '/v1/employees?level=L1,L2&isActive=true&limit=50', { tests: [status(200), "pm.test('filtered', () => pm.response.json().data.forEach(e => { pm.expect(['L1','L2']).to.include(e.level); pm.expect(e.isActive).to.eql(true); }));"] }),
  req('Text search', 'GET', '/v1/products?q=sku-0000&limit=5', { tests: [status(200), "pm.test('matches', () => pm.expect(pm.response.json().data.length).to.be.above(0));"] }),
  req('Unknown filter field → 400', 'GET', '/v1/employees?colour=blue', { tests: problem(400) }),
]);

// Pagination walkers: each request loops on itself with setNextRequest until the last page.
// Walker variables are initialised by the "Reset walkers" request (not in request pre-scripts), because the
// collection-level auth/HMAC script runs first and must already see the final URL.
function walker(name, raw, { step, headers = {} }) {
  return req(name, 'GET', raw, {
    headers,
    tests: [
      status(200),
      'const body = pm.response.json();',
      ...step,
      "const ids = (pm.environment.get('walk_ids') || '').split(',').filter(Boolean).concat(items.map(x => String(x.id)));",
      "pm.environment.set('walk_ids', ids.join(','));",
      'if (more) { postman.setNextRequest(pm.info.requestName); } else {',
      "  pm.test('walked every item exactly once', () => { pm.expect(new Set(ids).size).to.eql(ids.length); pm.expect(ids.length).to.eql(Number(pm.environment.get(total))); });",
      "  pm.environment.set('walk_ids', '');",
      '}',
    ],
  });
}
const pagination = folder('Pagination (follow to the end)', [
  req('Reset walkers', 'GET', '/health', {
    tests: [
      status(200),
      "const b = pm.environment.get('baseUrl');",
      "pm.environment.set('totalEmployees', pm.response.json().data.employees); pm.environment.set('totalProducts', pm.response.json().data.products);",
      "pm.environment.set('walk_ids', ''); pm.environment.set('w_offset', 0); pm.environment.set('w_page', 1); pm.environment.set('w_cursor', '');",
      "pm.environment.set('w_after', 0); pm.environment.set('w_token', '');",
      "pm.environment.set('w_link', b + '/v1/p/link/employees?page=1&per_page=40'); pm.environment.set('w_hal', b + '/v1/p/hal/products?page=1&size=50');",
    ],
  }),
  walker('offset', '/v1/p/offset/employees?offset={{w_offset}}&limit=40', { step: ["const total = 'totalEmployees'; const items = body.data;", "const more = body.meta.offset + body.meta.limit < body.meta.total;", "pm.environment.set('w_offset', body.meta.offset + body.meta.limit);"] }),
  walker('page', '/v1/p/page/products?page={{w_page}}&size=50', { step: ["const total = 'totalProducts'; const items = body.data;", "const more = body.meta.page < body.meta.totalPages;", "pm.environment.set('w_page', body.meta.page + 1);"] }),
  walker('cursor', '/v1/p/cursor/employees?limit=40&cursor={{w_cursor}}', { step: ["const total = 'totalEmployees'; const items = body.data;", 'const more = !!body.nextCursor;', "pm.environment.set('w_cursor', body.nextCursor || '');"] }),
  walker('keyset', '/v1/p/keyset/products?after_id={{w_after}}&limit=60', { step: ["const total = 'totalProducts'; const items = body.data;", 'const more = body.hasMore;', "pm.environment.set('w_after', body.lastId);"] }),
  walker('link (RFC 8288)', '{{w_link}}', { step: ["const total = 'totalEmployees'; const items = body;", "pm.test('X-Total-Count', () => pm.expect(Number(pm.response.headers.get('X-Total-Count'))).to.eql(Number(pm.environment.get('totalEmployees'))));", "const m = /<([^>]+)>;\\s*rel=\"next\"/.exec(pm.response.headers.get('Link') || '');", 'const more = !!m;', "if (m) pm.environment.set('w_link', m[1]);"] }),
  walker('HAL', '{{w_hal}}', { step: ["const total = 'totalProducts'; const items = body._embedded.products;", 'const more = !!body._links.next;', "if (more) pm.environment.set('w_hal', body._links.next.href);"] }),
  walker('token (nextPageToken)', '/v1/p/token/employees?pageSize=40&pageToken={{w_token}}', { step: ["const total = 'totalEmployees'; const items = body.items;", 'const more = body.nextPageToken !== null;', "pm.environment.set('w_token', body.nextPageToken || '');"] }),
]);

const chaos = folder('Chaos forcing headers', [
  req('X-Force-Error: 503', 'GET', '/v1/employees/1', { headers: { 'X-Force-Error': '503' }, tests: [...problem(503), "pm.test('X-Chaos-Injected', () => pm.expect(pm.response.headers.get('X-Chaos-Injected')).to.eql('503'));", "pm.test('Retry-After', () => pm.expect(pm.response.headers.get('Retry-After')).to.eql('5'));"] }),
  req('X-Force-Error: 429', 'GET', '/v1/employees/1', { headers: { 'X-Force-Error': '429' }, tests: problem(429) }),
  req('X-Force-Status: 202', 'GET', '/v1/employees/1', { headers: { 'X-Force-Status': '202' }, tests: [status(202), "pm.test('real body', () => pm.expect(pm.response.json().id).to.eql(1));"] }),
  req('X-Force-Latency: 300', 'GET', '/v1/employees/1', { headers: { 'X-Force-Latency': '300' }, tests: [status(200), "pm.test('slow', () => pm.expect(pm.response.responseTime).to.be.at.least(290));"] }),
  req('X-Force-Error: malformed-json', 'GET', '/v1/employees/1', { headers: { 'X-Force-Error': 'malformed-json' }, tests: [status(200), "pm.test('not parseable', () => pm.expect(() => JSON.parse(pm.response.text())).to.throw());"] }),
  req('X-Force-Error: wrong-content-type', 'GET', '/v1/employees/1', { headers: { 'X-Force-Error': 'wrong-content-type' }, tests: ["pm.test('text/html', () => pm.expect(pm.response.headers.get('Content-Type')).to.include('text/html'));"] }),
  req('X-Force-Error: empty-body', 'GET', '/v1/employees/1', { headers: { 'X-Force-Error': 'empty-body' }, tests: ["pm.test('empty', () => pm.expect(pm.response.text()).to.eql(''));"] }),
  req('Unknown chaos type → 400', 'GET', '/v1/employees/1', { headers: { 'X-Force-Error': 'banana' }, tests: problem(400) }),
]);

const files = folder('Files', [
  req('List', 'GET', '/v1/files?limit=50', { tests: [status(200), "pm.test('samples present', () => pm.expect(pm.response.json().data.map(f => f.id)).to.include('sample-large-bin'));"] }),
  req('Multipart upload', 'POST', '/v1/files/multipart', {
    body: { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: 'fixtures/hello.txt' }, { key: 'description', type: 'text', value: 'from postman' }] },
    tests: [status(201), "const b = pm.response.json();", "pm.test('one file + field', () => { pm.expect(b.files).to.have.length(1); pm.expect(b.fields.description).to.eql('from postman'); });", "pm.environment.set('mpFileId', b.files[0].id);"],
  }),
  req('Download multipart file', 'GET', '/v1/files/{{mpFileId}}/download', { tests: [status(200), "pm.test('content', () => pm.expect(pm.response.text()).to.include('Hello from the API Test Tool fixture'));", "pm.test('Content-Disposition', () => pm.expect(pm.response.headers.get('Content-Disposition')).to.include('attachment'));"] }),
  req('Raw PUT', 'PUT', '/v1/files/raw/postman-raw.txt', { headers: { 'Content-Type': 'text/plain' }, body: rawText('raw upload from postman'), tests: [status(201), "pm.environment.set('rawFileId', pm.response.json().id);", "pm.test('name from path', () => pm.expect(pm.response.json().name).to.eql('postman-raw.txt'));"] }),
  req('Base64 upload', 'POST', '/v1/files/base64', { headers: { 'Content-Type': 'application/json' }, body: json({ name: 'b64.txt', contentType: 'text/plain', data: 'aGVsbG8gYmFzZTY0' }), tests: [status(201), "pm.environment.set('b64FileId', pm.response.json().id);"] }),
  req('Base64 download', 'GET', '/v1/files/{{b64FileId}}/base64', { tests: [status(200), "pm.test('round trip', () => pm.expect(pm.response.json().data).to.eql('aGVsbG8gYmFzZTY0'));"] }),
  req('Presign PUT', 'POST', '/v1/files/presign', { headers: { 'Content-Type': 'application/json' }, body: json({ method: 'PUT', name: 'presigned.txt', contentType: 'text/plain', expiresIn: 300 }), tests: [status(201), "pm.environment.set('presignPutUrl', pm.response.json().url); pm.environment.set('presignFileId', pm.response.json().fileId);"] }),
  req('Upload to presigned URL', 'PUT', '{{presignPutUrl}}', { headers: { 'Content-Type': 'text/plain' }, body: rawText('uploaded through a presigned URL'), tests: ["pm.test('2xx', () => pm.expect(pm.response.code).to.be.within(200, 204));"] }),
  req('Presign GET', 'POST', '/v1/files/presign', { headers: { 'Content-Type': 'application/json' }, body: json({ method: 'GET', fileId: '{{presignFileId}}', expiresIn: 300 }), tests: [status(201), "pm.environment.set('presignGetUrl', pm.response.json().url);"] }),
  req('Download from presigned URL', 'GET', '{{presignGetUrl}}', { tests: [status(200), "pm.test('content', () => pm.expect(pm.response.text()).to.eql('uploaded through a presigned URL'));"] }),
  req('Range download → 206', 'GET', '/v1/files/sample-large-bin/download', { headers: { Range: 'bytes=0-1023' }, tests: [status(206), "pm.test('Content-Range', () => pm.expect(pm.response.headers.get('Content-Range')).to.eql('bytes 0-1023/10485760'));", "pm.test('Accept-Ranges', () => pm.expect(pm.response.headers.get('Accept-Ranges')).to.eql('bytes'));"] }),
  req('Range not satisfiable → 416', 'GET', '/v1/files/sample-readme-txt/download', { headers: { Range: 'bytes=99999999-' }, tests: problem(416) }),
  req('Chunked download', 'GET', '/v1/files/sample-employees-csv/chunked', { tests: [status(200), "pm.test('chunked', () => { pm.expect(pm.response.headers.get('Transfer-Encoding')).to.eql('chunked'); pm.expect(pm.response.headers.has('Content-Length')).to.eql(false); });"] }),
  req('tus: create', 'POST', '/v1/files/tus', { headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': '22', 'Upload-Metadata': 'filename dHVzLnR4dA==,filetype dGV4dC9wbGFpbg==' }, tests: [status(201), "pm.environment.set('tusUrl', pm.response.headers.get('Location'));"] }),
  req('tus: patch chunk 1', 'PATCH', '{{tusUrl}}', { headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: rawText('resumable '), tests: [status(204), "pm.test('offset 10', () => pm.expect(pm.response.headers.get('Upload-Offset')).to.eql('10'));"] }),
  req('tus: head', 'HEAD', '{{tusUrl}}', { headers: { 'Tus-Resumable': '1.0.0' }, tests: [status(200), "pm.test('offset 10', () => pm.expect(pm.response.headers.get('Upload-Offset')).to.eql('10'));"] }),
  req('tus: patch chunk 2 (completes)', 'PATCH', '{{tusUrl}}', { headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '10', 'Content-Type': 'application/offset+octet-stream' }, body: rawText('upload done!'), tests: [status(204), "pm.environment.set('tusFileId', pm.response.headers.get('X-File-Id'));", "pm.test('file id', () => pm.expect(pm.environment.get('tusFileId')).to.be.a('string'));"] }),
  req('tus file in the shared pool (range)', 'GET', '/v1/files/{{tusFileId}}/download', { headers: { Range: 'bytes=0-8' }, tests: [status(206), "pm.test('bytes', () => pm.expect(pm.response.text()).to.eql('resumable'));"] }),
  req('Delete raw file', 'DELETE', '/v1/files/{{rawFileId}}', { tests: [status(204)] }),
]);

const EMP_NS = 'urn:api-test-tool:soap:EmployeeService';
const PROD_NS = 'urn:api-test-tool:soap:ProductService';
const soapEnv = (version, ns, inner) => `<soapenv:Envelope xmlns:soapenv="${version === '1.2' ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/'}" xmlns:tns="${ns}"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
const soap11 = (ns, op, inner, extraHeaders = {}) => ({ headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${ns}/${op}"`, ...extraHeaders }, body: rawText(soapEnv('1.1', ns, `<tns:${op}>${inner}</tns:${op}>`)) });
const soap12 = (ns, op, inner) => ({ headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${ns}/${op}"` }, body: rawText(soapEnv('1.2', ns, `<tns:${op}>${inner}</tns:${op}>`)) });
const has = (label, text) => `pm.test(${JSON.stringify(label)}, () => pm.expect(pm.response.text()).to.include(${JSON.stringify(text)}));`;
const ctype = (t) => `pm.test('Content-Type ${t}', () => pm.expect(pm.response.headers.get('Content-Type')).to.include('${t}'));`;
const soapFolder = folder('SOAP', [
  req('List services', 'GET', '/soap', { tests: [status(200), "pm.test('two services', () => pm.expect(pm.response.json().services.map((s) => s.name)).to.eql(['EmployeeService', 'ProductService']));"] }),
  req('EmployeeService WSDL (always open)', 'GET', '/soap/EmployeeService?wsdl', { tests: [status(200), ctype('text/xml'), has('WSDL', '<wsdl:definitions'), has('SOAP 1.2 binding', 'EmployeeServiceSoap12')] }),
  req('GetEmployee (SOAP 1.1)', 'POST', '/soap/EmployeeService', { ...soap11(EMP_NS, 'GetEmployee', '<tns:id>1</tns:id>'), tests: [status(200), ctype('text/xml'), has('employee 1', '<tns:id>1</tns:id>'), "pm.test('operation header', () => pm.expect(pm.response.headers.get('X-Soap-Operation')).to.eql('GetEmployee'));"] }),
  req('ListProducts page 2 (SOAP 1.2)', 'POST', '/soap/ProductService', { ...soap12(PROD_NS, 'ListProducts', '<tns:page>2</tns:page><tns:pageSize>5</tns:pageSize>'), tests: [status(200), ctype('application/soap+xml'), has('page 2', '<tns:page>2</tns:page>'), "pm.test('five products', () => pm.expect((pm.response.text().match(/<tns:product>/g) || []).length).to.eql(5));"] }),
  req('CreateEmployee', 'POST', '/soap/EmployeeService', {
    ...soap11(EMP_NS, 'CreateEmployee', '<tns:employee><tns:firstName>Soap</tns:firstName><tns:lastName>Client</tns:lastName><tns:email>soap.client@example.com</tns:email><tns:departmentId>1</tns:departmentId></tns:employee>'),
    tests: [status(200), "const m = pm.response.text().match(/<tns:employee><tns:id>(\\d+)<\\/tns:id>/); pm.test('new id', () => pm.expect(m).to.not.eql(null)); if (m) pm.environment.set('soapEmpId', m[1]);"],
  }),
  req('UpdateEmployee', 'POST', '/soap/EmployeeService', { ...soap11(EMP_NS, 'UpdateEmployee', '<tns:id>{{soapEmpId}}</tns:id><tns:employee><tns:title>Integration tester</tns:title></tns:employee>'), tests: [status(200), has('title changed', '<tns:title>Integration tester</tns:title>'), has('rest kept', '<tns:firstName>Soap</tns:firstName>')] }),
  req('DeleteEmployee', 'POST', '/soap/EmployeeService', { ...soap11(EMP_NS, 'DeleteEmployee', '<tns:id>{{soapEmpId}}</tns:id>'), tests: [status(200), has('deleted', '<tns:deleted>true</tns:deleted>')] }),
  req('Not found → SOAP 1.1 Client fault (HTTP 500)', 'POST', '/soap/EmployeeService', { ...soap11(EMP_NS, 'GetEmployee', '<tns:id>{{soapEmpId}}</tns:id>'), tests: [status(500), has('Client fault', '<faultcode>soap:Client</faultcode>'), has('code', '<f:code>not-found</f:code>')] }),
  req('Not found → SOAP 1.2 Sender fault (HTTP 400)', 'POST', '/soap/EmployeeService', { ...soap12(EMP_NS, 'GetEmployee', '<tns:id>{{soapEmpId}}</tns:id>'), tests: [status(400), has('Sender', '<soap:Value>soap:Sender</soap:Value>'), has('subcode', 'f:NotFound')] }),
  req('Validation errors in the fault detail', 'POST', '/soap/EmployeeService', { ...soap11(EMP_NS, 'CreateEmployee', '<tns:employee><tns:firstName>Only</tns:firstName></tns:employee>'), tests: [status(500), has('validation', '<f:code>validation-failed</f:code>'), has('field error', 'field="email"')] }),
  req('Wrong SOAPAction → fault', 'POST', '/soap/EmployeeService', { ...soap11(EMP_NS, 'GetEmployee', '<tns:id>1</tns:id>', { SOAPAction: `"${EMP_NS}/DeleteEmployee"` }), tests: [status(500), has('mismatch', 'soap-action-mismatch')] }),
  req('X-Force-Error: 503 → fault with the real status', 'POST', '/soap/EmployeeService', { ...soap11(EMP_NS, 'GetEmployee', '<tns:id>1</tns:id>', { 'X-Force-Error': '503' }), tests: [status(503), has('Server fault', '<faultcode>soap:Server</faultcode>'), "pm.test('X-Chaos-Injected', () => pm.expect(pm.response.headers.get('X-Chaos-Injected')).to.eql('503'));"] }),
]);

const sseCount = (event, n) => `pm.test('${n} × event: ${event}', () => pm.expect((pm.response.text().match(/^event: ${event}$/gm) || []).length).to.eql(${n}));`;
const sseFolder = folder('Server-Sent Events', [
  req('List streams', 'GET', '/sse', { tests: [status(200), "pm.test('three streams', () => pm.expect(pm.response.json().streams.length).to.eql(3));"] }),
  req('Ticks: three events then end', 'GET', '/sse/ticks?interval=100&count=3', { tests: [status(200), ctype('text/event-stream'), sseCount('tick', 3), sseCount('end', 1), has('retry line', 'retry: '), has('ids', 'id: 3')] }),
  req('Ticks resume after Last-Event-ID', 'GET', '/sse/ticks?interval=50&count=4', { headers: { 'Last-Event-ID': '2' }, tests: [status(200), sseCount('tick', 2), has('starts at 3', 'id: 3')] }),
  req('Stream (event format)', 'POST', '/sse/stream', { headers: { 'Content-Type': 'application/json' }, body: json({ prompt: 'Who is on the team?', words: 8, delayMs: 10 }), tests: [status(200), ctype('text/event-stream'), sseCount('message', 8), sseCount('done', 1)] }),
  req('Stream (OpenAI chunk format)', 'POST', '/sse/stream', { headers: { 'Content-Type': 'application/json' }, body: json({ words: 5, delayMs: 10, format: 'openai' }), tests: [status(200), has('chunk objects', 'chat.completion.chunk'), has('terminator', 'data: [DONE]')] }),
  req('Unknown resource → 400 before the stream starts', 'GET', '/sse/changes?resource=widgets', { tests: problem(400) }),
]);

const gql = (query, variables = '{}') => ({ mode: 'raw', raw: `{"query": ${JSON.stringify(query)}, "variables": ${variables}}`, options: { raw: { language: 'json' } } });
const GQL_JSON = { 'Content-Type': 'application/json' };
const gqlCode = (code, i = 0) => `pm.test('extensions.code ${code}', () => pm.expect(pm.response.json().errors[${i}].extensions.code).to.eql('${code}'));`;
const gqlNoErrors = "pm.test('no errors', () => pm.expect(pm.response.json().errors).to.eql(undefined));";
// ---------------------------------------------------------------- mock LLM (OpenAI-compatible)
const jsonCt = { 'Content-Type': 'application/json' };
const oaError = (code, errCode) => [status(code), "pm.test('OpenAI error shape', () => { const e = pm.response.json().error; pm.expect(e).to.be.an('object'); pm.expect(e.message).to.be.a('string'); pm.expect(e.type).to.be.a('string'); });",
  ...(errCode ? [`pm.test('code ${errCode}', () => pm.expect(pm.response.json().error.code).to.eql('${errCode}'));`] : [])];
const usageOk = "pm.test('usage adds up', () => { const u = pm.response.json().usage; pm.expect(u.prompt_tokens).to.be.above(0); pm.expect(u.completion_tokens).to.be.at.least(0); pm.expect(u.total_tokens).to.eql(u.prompt_tokens + u.completion_tokens); });";
const weatherTool = { type: 'function', function: { name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city', 'unit'] } } };
const llmFolder = folder('Mock LLM (OpenAI-compatible)', [
  req('List models', 'GET', '/llm/v1/models', { tests: [status(200), "pm.test('list of models', () => { const b = pm.response.json(); pm.expect(b.object).to.eql('list'); pm.expect(b.data.length).to.be.above(0); pm.expect(b.data[0].object).to.eql('model'); });"] }),
  req('Chat completion', 'POST', '/llm/v1/chat/completions', { headers: jsonCt, body: json({ model: 'mock-chat-large', messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Summarize our Q3 plan in a few sentences.' }] }), tests: [status(200), "pm.test('chat.completion with text', () => { const b = pm.response.json(); pm.expect(b.object).to.eql('chat.completion'); pm.expect(b.model).to.eql('mock-chat-large'); pm.expect(b.choices[0].message.role).to.eql('assistant'); pm.expect(b.choices[0].message.content).to.be.a('string').and.not.empty; pm.expect(b.choices[0].finish_reason).to.eql('stop'); });", usageOk] }),
  req('Same seed → same answer (1 of 2)', 'POST', '/llm/v1/chat/completions', { headers: jsonCt, body: json({ model: 'mock-chat-small', seed: 42, messages: [{ role: 'user', content: 'Hello' }] }), tests: [status(200), "pm.collectionVariables.set('llmSeedAnswer', pm.response.json().choices[0].message.content); pm.collectionVariables.set('llmSeedUsage', JSON.stringify(pm.response.json().usage));"] }),
  req('Same seed → same answer (2 of 2)', 'POST', '/llm/v1/chat/completions', { headers: jsonCt, body: json({ model: 'mock-chat-small', seed: 42, messages: [{ role: 'user', content: 'Hello' }] }), tests: [status(200), "pm.test('repeatable', () => { pm.expect(pm.response.json().choices[0].message.content).to.eql(pm.collectionVariables.get('llmSeedAnswer')); pm.expect(JSON.stringify(pm.response.json().usage)).to.eql(pm.collectionVariables.get('llmSeedUsage')); });"] }),
  req('max_tokens → finish_reason length', 'POST', '/llm/v1/chat/completions', { headers: jsonCt, body: json({ model: 'mock-chat-large', max_tokens: 5, messages: [{ role: 'user', content: 'Write a long essay.' }] }), tests: [status(200), "pm.test('cut at 5 tokens', () => { const b = pm.response.json(); pm.expect(b.choices[0].finish_reason).to.eql('length'); pm.expect(b.usage.completion_tokens).to.eql(5); });"] }),
  req('Tool call (required)', 'POST', '/llm/v1/chat/completions', { headers: jsonCt, body: json({ model: 'mock-chat-large', tool_choice: 'required', tools: [weatherTool], messages: [{ role: 'user', content: 'Weather in Boston?' }] }), tests: [status(200), "pm.test('tool call with schema-valid arguments', () => { const c = pm.response.json().choices[0]; pm.expect(c.finish_reason).to.eql('tool_calls'); const tc = c.message.tool_calls[0]; pm.expect(tc.function.name).to.eql('get_weather'); const a = JSON.parse(tc.function.arguments); pm.expect(a.city).to.be.a('string'); pm.expect(['celsius', 'fahrenheit']).to.include(a.unit); });"] }),
  req('Reply to a tool result is text', 'POST', '/llm/v1/chat/completions', { headers: jsonCt, body: json({ model: 'mock-chat-large', tools: [weatherTool], messages: [{ role: 'user', content: 'Weather in Boston?' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Boston","unit":"celsius"}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: '{"temp": 18}' }] }), tests: [status(200), "pm.test('text answer', () => { const c = pm.response.json().choices[0]; pm.expect(c.finish_reason).to.eql('stop'); pm.expect(c.message.content).to.be.a('string'); });"] }),
  req('JSON output', 'POST', '/llm/v1/chat/completions', { headers: jsonCt, body: json({ model: 'mock-chat-large', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'Risk summary as JSON' }] }), tests: [status(200), "pm.test('content is a JSON object', () => pm.expect(JSON.parse(pm.response.json().choices[0].message.content)).to.be.an('object'));"] }),
  req('Streamed, with usage chunk', 'POST', '/llm/v1/chat/completions', { headers: jsonCt, body: json({ model: 'mock-chat-large', stream: true, stream_options: { include_usage: true }, max_tokens: 12, messages: [{ role: 'user', content: 'Hi' }] }), tests: [status(200), ctype('text/event-stream'), has('chunk objects', 'chat.completion.chunk'), has('usage chunk', '"choices":[],"usage":{'), has('terminator', 'data: [DONE]')] }),
  req('Embeddings', 'POST', '/llm/v1/embeddings', { headers: jsonCt, body: json({ model: 'mock-embed-small', input: ['first text', 'second text'], dimensions: 8 }), tests: [status(200), "pm.test('two unit vectors of 8', () => { const b = pm.response.json(); pm.expect(b.data).to.have.length(2); pm.expect(b.data[0].embedding).to.have.length(8); const n = Math.sqrt(b.data[0].embedding.reduce((a, v) => a + v * v, 0)); pm.expect(Math.abs(n - 1)).to.be.below(0.001); pm.expect(b.usage.prompt_tokens).to.be.above(0); });"] }),
  req('Missing messages → 400', 'POST', '/llm/v1/chat/completions', { headers: jsonCt, body: json({ model: 'mock-chat-large' }), tests: [...oaError(400), "pm.test('param names the field', () => pm.expect(pm.response.json().error.param).to.eql('messages'));"] }),
  req('Unknown model → 404', 'GET', '/llm/v1/models/no-such-model', { tests: oaError(404, 'model_not_found') }),
  req('Injected 429 → OpenAI rate-limit error', 'GET', '/llm/v1/models', { headers: { 'X-Force-Error': '429' }, tests: [...oaError(429, 'rate_limit_exceeded'), "pm.test('Retry-After', () => pm.expect(pm.response.headers.get('Retry-After')).to.be.ok);"] }),
], 'OpenAI-compatible mock LLM at /llm/v1. Uses the active auth mode; errors are OpenAI-shaped.');

// ---------------------------------------------------------------- MCP server
const MCP_META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'postman', version: '1' } };
const mcpH = (method, name, extra = {}) => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}), ...extra });
const mcpReq = (title, method, params = {}, { headers = {}, tests = [], id = 1 } = {}) => req(title, 'POST', '/mcp', {
  headers: mcpH(method, params.name || params.uri, headers),
  body: json({ jsonrpc: '2.0', id, method, params: { ...params, _meta: { ...MCP_META, ...(params._meta || {}) } } }),
  tests,
});
const rpcErr = (code) => `pm.test('JSON-RPC error ${code}', () => pm.expect(pm.response.json().error.code).to.eql(${code}));`;
const legacyH = (extra = {}) => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': '{{mcpSessionId}}', 'MCP-Protocol-Version': '2025-11-25', ...extra });
const mcpFolder = folder('MCP server', [
  mcpReq('server/discover', 'server/discover', {}, { tests: [status(200), "pm.test('modern discover result', () => { const r = pm.response.json().result; pm.expect(r.resultType).to.eql('complete'); pm.expect(r.supportedVersions).to.include('2026-07-28'); pm.expect(r.ttlMs).to.be.at.least(0); });"] }),
  mcpReq('tools/list', 'tools/list', {}, { tests: [status(200), "pm.test('22 tools in a stable order', () => { const t = pm.response.json().result.tools; pm.expect(t.length).to.eql(22); pm.expect(t[0].name).to.eql('search_employees'); });"] }),
  mcpReq('tools/call get_employee', 'tools/call', { name: 'get_employee', arguments: { id: 1 } }, { tests: [status(200), "pm.test('structured result', () => { const r = pm.response.json().result; pm.expect(r.structuredContent.id).to.eql(1); pm.expect(r.content[0].type).to.eql('text'); pm.expect(r.isError).to.not.eql(true); });"] }),
  mcpReq('tools/call with x-mcp-header argument', 'tools/call', { name: 'search_employees', arguments: { department: 'Engineering', limit: 3 } }, { headers: { 'Mcp-Param-Department': 'Engineering' }, tests: [status(200), "pm.test('filtered by department', () => pm.expect(pm.response.json().result.structuredContent.items.every((e) => /Engineering/.test(e.department))).to.be.true);"] }),
  mcpReq('Missing Mcp-Param header → 400 HeaderMismatch', 'tools/call', { name: 'search_employees', arguments: { department: 'Engineering' } }, { tests: [status(400), rpcErr(-32020)] }),
  mcpReq('Missing record → tool error', 'tools/call', { name: 'get_employee', arguments: { id: 999999 } }, { tests: [status(200), "pm.test('isError', () => pm.expect(pm.response.json().result.isError).to.eql(true));"] }),
  mcpReq('Unknown tool → -32602', 'tools/call', { name: 'no_such_tool', arguments: {} }, { tests: [status(200), rpcErr(-32602)] }),
  req('Unsupported protocol version → 400 -32022', 'POST', '/mcp', { headers: mcpH('tools/list', null, { 'MCP-Protocol-Version': '1900-01-01' }), body: json({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...MCP_META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } }), tests: [status(400), rpcErr(-32022), "pm.test('lists supported versions', () => pm.expect(pm.response.json().error.data.supported).to.include('2026-07-28'));"] }),
  mcpReq('resources/read', 'resources/read', { uri: 'att://departments/1' }, { tests: [status(200), "pm.test('JSON contents', () => pm.expect(JSON.parse(pm.response.json().result.contents[0].text).id).to.eql(1));"] }),
  mcpReq('prompts/get', 'prompts/get', { name: 'summarize_department', arguments: { departmentId: '1' } }, { tests: [status(200), "pm.test('messages with an embedded resource', () => pm.expect(pm.response.json().result.messages[1].content.type).to.eql('resource'));"] }),
  mcpReq('Streamed progress (SSE)', 'tools/call', { name: 'long_running_task', arguments: { seconds: 1, steps: 2 }, _meta: { progressToken: 'pm' } }, { tests: [status(200), ctype('text/event-stream'), has('progress notifications', 'notifications/progress'), has('final result', '"done":true')] }),
  req('Protected resource metadata', 'GET', '/.well-known/oauth-protected-resource/mcp', { tests: [status(200), "pm.test('names /mcp and the authorization server', () => { const b = pm.response.json(); pm.expect(b.resource).to.match(/\\/mcp$/); pm.expect(b.authorization_servers.length).to.eql(1); });"] }),
  req('Legacy: initialize (session)', 'POST', '/mcp', { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: json({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'postman', version: '1' } } }),
    tests: [status(200), "pm.test('negotiated 2025-11-25 with a session id', () => { pm.expect(pm.response.json().result.protocolVersion).to.eql('2025-11-25'); pm.expect(pm.response.headers.get('Mcp-Session-Id')).to.be.ok; });", "pm.collectionVariables.set('mcpSessionId', pm.response.headers.get('Mcp-Session-Id'));"] }),
  req('Legacy: notifications/initialized → 202', 'POST', '/mcp', { headers: legacyH(), body: json({ jsonrpc: '2.0', method: 'notifications/initialized' }), tests: [status(202)] }),
  req('Legacy: tools/list in the session', 'POST', '/mcp', { headers: legacyH(), body: json({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), tests: [status(200), "pm.test('22 tools, no 2026-07-28 fields', () => { const r = pm.response.json().result; pm.expect(r.tools.length).to.eql(22); pm.expect(r.resultType).to.be.undefined; });"] }),
  req('Legacy: DELETE ends the session', 'DELETE', '/mcp', { headers: { 'Mcp-Session-Id': '{{mcpSessionId}}' }, tests: [status(204)] }),
  req('Legacy: the ended session → 404', 'POST', '/mcp', { headers: legacyH(), body: json({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), tests: [status(404), rpcErr(-32001)] }),
], 'Mock MCP server at /mcp: protocol 2026-07-28 requests (with the required headers) and a 2025-11-25 session. Uses the active auth mode.');

// ---------------------------------------------------------------- A2A agent
const a2aMsg = (text, extra = {}) => ({ messageId: `pm-${text.length}-${Math.floor(text.charCodeAt(0))}`, role: 'ROLE_USER', parts: [{ text }], ...extra });
const a2aH = { 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
const a2aRpc = (title, method, params, tests, headers = {}) => req(title, 'POST', '/a2a', { headers: { ...a2aH, ...headers }, body: json({ jsonrpc: '2.0', id: 1, method, params }), tests });
const a2aState = (state) => `pm.test('task ${state}', () => pm.expect(pm.response.json().result.task.status.state).to.eql('${state}'));`;
const a2aCode = (code) => `pm.test('A2A error ${code}', () => pm.expect(pm.response.json().error.code).to.eql(${code}));`;
const a2aFolder = folder('A2A agent', [
  req('Agent Card (1.0)', 'GET', '/.well-known/agent-card.json', { tests: [status(200), "pm.test('three interfaces and four skills', () => { const c = pm.response.json(); pm.expect(c.supportedInterfaces.map((i) => i.protocolBinding + ' ' + i.protocolVersion)).to.eql(['JSONRPC 1.0', 'HTTP+JSON 1.0', 'JSONRPC 0.3']); pm.expect(c.skills.length).to.eql(4); pm.expect(c.capabilities.streaming).to.eql(true); });"] }),
  req('Agent Card (0.3)', 'GET', '/a2a/v0.3/.well-known/agent-card.json', { tests: [status(200), "pm.test('0.3 card', () => { pm.expect(pm.response.json().protocolVersion).to.eql('0.3.0'); pm.expect(pm.response.json().url).to.match(/\\/a2a\\/v0\\.3$/); });"] }),
  a2aRpc('SendMessage: greeting → direct Message', 'SendMessage', { message: a2aMsg('hello') }, [status(200), "pm.test('a Message, not a task', () => pm.expect(pm.response.json().result.message.role).to.eql('ROLE_AGENT'));"]),
  a2aRpc('SendMessage: question → COMPLETED task', 'SendMessage', { message: a2aMsg('Who works in Engineering?') }, [status(200), a2aState('TASK_STATE_COMPLETED'),
    "pm.test('answer and data artifacts', () => { const a = pm.response.json().result.task.artifacts; pm.expect(a.map((x) => x.name)).to.eql(['answer', 'data']); pm.expect(a[0].parts[0].text).to.match(/Found \\d+ employee/); });",
    "pm.collectionVariables.set('a2aTaskId', pm.response.json().result.task.id);"]),
  a2aRpc('GetTask', 'GetTask', { id: '{{a2aTaskId}}', historyLength: 1 }, [status(200), "pm.test('the same task', () => pm.expect(pm.response.json().result.id).to.eql(pm.collectionVariables.get('a2aTaskId')));"]),
  a2aRpc('ListTasks', 'ListTasks', { pageSize: 2 }, [status(200), "pm.test('a page of tasks', () => { const r = pm.response.json().result; pm.expect(r.tasks.length).to.be.at.most(2); pm.expect(r.totalSize).to.be.at.least(1); pm.expect(r).to.have.property('nextPageToken'); });"]),
  a2aRpc('Missing record → FAILED', 'SendMessage', { message: a2aMsg('show employee 999999') }, [status(200), a2aState('TASK_STATE_FAILED')]),
  a2aRpc('Out of scope → REJECTED', 'SendMessage', { message: a2aMsg('What is the weather in Boston?') }, [status(200), a2aState('TASK_STATE_REJECTED')]),
  a2aRpc('Delete product → INPUT_REQUIRED', 'SendMessage', { message: a2aMsg('delete product 3') }, [status(200), a2aState('TASK_STATE_INPUT_REQUIRED'), "pm.collectionVariables.set('a2aAskId', pm.response.json().result.task.id);"]),
  a2aRpc('Answer "no" on the same task → REJECTED', 'SendMessage', { message: { messageId: 'pm-no', role: 'ROLE_USER', parts: [{ text: 'no' }], taskId: '{{a2aAskId}}' } }, [status(200), a2aState('TASK_STATE_REJECTED')]),
  a2aRpc('Streamed answer', 'SendStreamingMessage', { message: a2aMsg('list departments') }, [status(200), ctype('text/event-stream'), has('task first', '"task":'), has('artifact updates', '"artifactUpdate"'), has('completed', 'TASK_STATE_COMPLETED')]),
  a2aRpc('Unknown task → -32001', 'GetTask', { id: 'no-such-task' }, [status(200), a2aCode(-32001)]),
  req('No A2A-Version header means 0.3 → -32601', 'POST', '/a2a', { headers: { 'Content-Type': 'application/json' }, body: json({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: a2aMsg('hi') } }), tests: [status(200), a2aCode(-32601), has('explains the header', 'A2A-Version: 1.0')] }),
  req('HTTP+JSON: message:send', 'POST', '/a2a/rest/message:send', { headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' }, body: json({ message: a2aMsg('show product 2') }), tests: [status(200), "pm.test('completed', () => pm.expect(pm.response.json().task.status.state).to.eql('TASK_STATE_COMPLETED'));"] }),
  req('HTTP+JSON: unknown task → 404 google.rpc.Status', 'GET', '/a2a/rest/tasks/no-such-task', { headers: { 'A2A-Version': '1.0' }, tests: [status(404), "pm.test('TASK_NOT_FOUND', () => pm.expect(pm.response.json().error.details[0].reason).to.eql('TASK_NOT_FOUND'));"] }),
  req('A2A 0.3: message/send', 'POST', '/a2a/v0.3', { headers: { 'Content-Type': 'application/json' }, body: json({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: 'pm-03', role: 'user', parts: [{ kind: 'text', text: 'list categories' }] } } }), tests: [status(200), "pm.test('0.3 task', () => { const r = pm.response.json().result; pm.expect(r.kind).to.eql('task'); pm.expect(r.status.state).to.eql('completed'); });"] }),
  a2aRpc('Forced failure', 'SendMessage', { message: a2aMsg('show employee 1') }, [status(200), a2aState('TASK_STATE_FAILED')], { 'X-Force-A2A-Error': 'fail' }),
], 'Mock A2A agent: Agent Cards, A2A 1.0 JSON-RPC and HTTP+JSON, and 0.3. Uses the active auth mode.');

const graphqlFolder = folder('GraphQL', [
  req('SDL (always open)', 'GET', '/graphql/schema.graphql', { tests: [status(200), has('Query type', 'type Query {'), has('Subscription type', 'type Subscription {')] }),
  req('Query: offset page with nested department', 'POST', '/graphql', { headers: GQL_JSON, body: gql('query($n: Int) { employees(limit: $n, sort: "id") { total items { id fullName department { name } } } }', '{"n": 3}'), tests: [status(200), ctype('application/json'), gqlNoErrors, "const d = pm.response.json().data.employees; pm.test('three items', () => pm.expect(d.items.length).to.eql(3)); pm.test('nested', () => pm.expect(d.items[0].department.name).to.be.a('string'));"] }),
  req('Query over GET', 'GET', `/graphql?query=${encodeURIComponent('{ product(id: 1) { id sku category { name } } }')}`, { tests: [status(200), gqlNoErrors, "pm.test('product 1', () => pm.expect(pm.response.json().data.product.id).to.eql(1));"] }),
  req('Relay connection: first page', 'POST', '/graphql', { headers: GQL_JSON, body: gql('{ productsConnection(first: 2) { totalCount pageInfo { hasNextPage endCursor } nodes { id } } }'), tests: [status(200), gqlNoErrors, "const c = pm.response.json().data.productsConnection; pm.test('ids 1,2', () => pm.expect(c.nodes.map((n) => n.id)).to.eql([1, 2])); pm.test('more pages', () => pm.expect(c.pageInfo.hasNextPage).to.eql(true)); pm.environment.set('gqlCursor', c.pageInfo.endCursor);"] }),
  req('Relay connection: next page', 'POST', '/graphql', { headers: GQL_JSON, body: gql('query($after: String) { productsConnection(first: 2, after: $after) { nodes { id } pageInfo { hasPreviousPage } } }', '{"after": "{{gqlCursor}}"}'), tests: [status(200), gqlNoErrors, "pm.test('ids 3,4', () => pm.expect(pm.response.json().data.productsConnection.nodes.map((n) => n.id)).to.eql([3, 4]));"] }),
  req('Filter and sort', 'POST', '/graphql', { headers: GQL_JSON, body: gql('{ employees(limit: 50, filter: [{ field: "level", value: "L3" }], sort: "-salary") { items { level salary } } }'), tests: [status(200), gqlNoErrors, "const it = pm.response.json().data.employees.items; pm.test('all L3', () => pm.expect(it.every((e) => e.level === 'L3')).to.eql(true)); pm.test('sorted', () => pm.expect(it.map((e) => e.salary)).to.eql(it.map((e) => e.salary).sort((a, b) => b - a)));"] }),
  req('Mutation: create department', 'POST', '/graphql', { headers: GQL_JSON, body: gql('mutation($in: DepartmentInput!) { createDepartment(input: $in) { id name code } }', '{"in": {"name": "GraphQL Postman", "code": "GQL-PM"}}'), tests: [status(200), gqlNoErrors, "pm.environment.set('gqlDeptId', pm.response.json().data.createDepartment.id);"] }),
  req('Mutation: update (merge patch)', 'POST', '/graphql', { headers: GQL_JSON, body: gql('mutation($id: Int!) { updateDepartment(id: $id, input: { name: "GraphQL Renamed" }) { name code } }', '{"id": {{gqlDeptId}}}'), tests: [status(200), gqlNoErrors, "pm.test('renamed, code kept', () => pm.expect(pm.response.json().data.updateDepartment).to.eql({ name: 'GraphQL Renamed', code: 'GQL-PM' }));"] }),
  req('Mutation: delete', 'POST', '/graphql', { headers: GQL_JSON, body: gql('mutation($id: Int!) { deleteDepartment(id: $id) { id deleted } }', '{"id": {{gqlDeptId}}}'), tests: [status(200), gqlNoErrors, "pm.test('deleted', () => pm.expect(pm.response.json().data.deleteDepartment.deleted).to.eql(true));"] }),
  req('Not found → field error NOT_FOUND (HTTP 200)', 'POST', '/graphql', { headers: GQL_JSON, body: gql('mutation($id: Int!) { deleteDepartment(id: $id) { deleted } }', '{"id": {{gqlDeptId}}}'), tests: [status(200), gqlCode('NOT_FOUND'), "pm.test('path', () => pm.expect(pm.response.json().errors[0].path).to.eql(['deleteDepartment']));"] }),
  req('Validation → BAD_USER_INPUT with field errors', 'POST', '/graphql', { headers: GQL_JSON, body: gql('mutation { createDepartment(input: { name: "Bad", code: "lower case" }) { id } }'), tests: [status(200), gqlCode('BAD_USER_INPUT'), "pm.test('field errors', () => pm.expect(pm.response.json().errors[0].extensions.errors.map((e) => e.field)).to.include('code'));"] }),
  req('Invalid query → 400 with graphql-response+json', 'POST', '/graphql', { headers: { ...GQL_JSON, Accept: 'application/graphql-response+json' }, body: gql('{ nope }'), tests: [status(400), ctype('application/graphql-response+json'), gqlCode('GRAPHQL_VALIDATION_FAILED'), "pm.test('no data entry', () => pm.expect(pm.response.json()).to.not.have.property('data'));"] }),
  req('Injected field error → partial data', 'POST', '/graphql', { headers: { ...GQL_JSON, 'X-Force-GraphQL-Error': 'department' }, body: gql('{ employees(limit: 2) { items { id department { name } } } }'), tests: [status(200), "const b = pm.response.json(); pm.test('data kept', () => pm.expect(b.data.employees.items.length).to.eql(2)); pm.test('department nulled', () => pm.expect(b.data.employees.items[0].department).to.eql(null)); pm.test('two errors', () => pm.expect(b.errors.length).to.eql(2));"] }),
  req('Mutation over GET → 405', 'GET', `/graphql?query=${encodeURIComponent('mutation { deleteCategory(id: 1) { deleted } }')}`, { tests: [status(405), gqlCode('METHOD_NOT_ALLOWED'), "pm.test('Allow: POST', () => pm.expect(pm.response.headers.get('Allow')).to.eql('POST'));"] }),
  req('X-Force-Error: 503 → errors with the real status', 'POST', '/graphql', { headers: { ...GQL_JSON, 'X-Force-Error': '503' }, body: gql('{ counts { employees } }'), tests: [status(503), gqlCode('SERVICE_UNAVAILABLE')] }),
]);

const od = (path, params = {}) => `/odata/v4/${path}${Object.keys(params).length ? `?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`).join('&')}` : ''}`; // fully encoded so HMAC signs what Postman sends
const odError = (code) => [status(code), "pm.test('OData error', () => { const e = pm.response.json().error; pm.expect(e.code).to.be.a('string'); pm.expect(e.message).to.be.a('string'); });", "pm.test('OData-Version', () => pm.expect(pm.response.headers.get('OData-Version')).to.eql('4.0'));"];
const odataFolder = folder('OData v4', [
  req('Service document (open)', 'GET', '/odata/v4', { tests: [status(200), "pm.test('four entity sets', () => pm.expect(pm.response.json().value.map((x) => x.name)).to.eql(['Employees', 'Products', 'Departments', 'Categories']));"] }),
  req('$metadata (open)', 'GET', '/odata/v4/$metadata', { tests: [status(200), ctype('application/xml'), has('CSDL', '<edmx:Edmx Version="4.0"'), has('Employee type', '<EntityType Name="Employee">')] }),
  req('Filter, select, orderby, count', 'GET', od('Employees', { $filter: "level eq 'L3' and salary gt 1", $select: 'level,salary', $orderby: 'salary desc', $count: 'true' }), { tests: [status(200), ctype('odata.metadata=minimal'), "const b = pm.response.json(); pm.test('count', () => pm.expect(b['@odata.count']).to.be.a('number')); pm.test('all L3', () => pm.expect(b.value.every((e) => e.level === 'L3')).to.eql(true)); pm.test('sorted', () => pm.expect(b.value.map((e) => e.salary)).to.eql(b.value.map((e) => e.salary).sort((x, y) => y - x)));"] }),
  req('Functions and lambda', 'GET', od('Employees', { $filter: "startswith(tolower(lastName),'a') or skills/any(s: s eq 'Go')", $select: 'lastName,skills' }), { tests: [status(200), "pm.test('matches', () => pm.expect(pm.response.json().value.every((e) => e.lastName.toLowerCase().startsWith('a') || e.skills.includes('Go'))).to.eql(true));"] }),
  req('Expand with nested options', 'GET', od('Departments(1)', { $expand: 'employees($select=firstName;$top=2;$count=true)' }), { tests: [status(200), "const b = pm.response.json(); pm.test('expanded', () => pm.expect(b.employees.length).to.be.at.most(2)); pm.test('nested count', () => pm.expect(b['employees@odata.count']).to.be.a('number')); pm.test('ETag', () => pm.expect(pm.response.headers.get('ETag')).to.match(/^W\\//));"] }),
  req('$count', 'GET', od('Products/$count', { $filter: 'inStock eq true' }), { tests: [status(200), "pm.test('a number', () => pm.expect(Number(pm.response.text())).to.be.a('number'));"] }),
  req('Property value', 'GET', '/odata/v4/Employees(1)/email/$value', { tests: [status(200), ctype('text/plain'), has('an email', '@')] }),
  req('Reset the paging walker', 'GET', '/health', { tests: [status(200), "pm.environment.set('walk_ids', ''); pm.environment.set('w_odata', pm.environment.get('baseUrl') + '/odata/v4/Products?$select=id');"] }),
  walker('Server paging: follow @odata.nextLink to the end', '{{w_odata}}', { headers: { Prefer: 'odata.maxpagesize=25' }, step: ["const total = 'totalProducts'; const items = body.value;", "pm.test('page size applied', () => { pm.expect(items.length).to.be.at.most(25); pm.expect(pm.response.headers.get('Preference-Applied')).to.eql('odata.maxpagesize=25'); });", "const more = !!body['@odata.nextLink'];", "if (more) pm.environment.set('w_odata', body['@odata.nextLink']);"] }),
  req('Create employee with @odata.bind', 'POST', '/odata/v4/Employees', { headers: { 'Content-Type': 'application/json' }, body: json({ firstName: 'OData', lastName: 'Postman', email: 'odata.postman@example.com', 'department@odata.bind': 'Departments(1)' }), tests: [status(201), "const b = pm.response.json(); pm.test('bound', () => pm.expect(b.departmentId).to.eql(1)); pm.test('Location', () => pm.expect(pm.response.headers.get('Location')).to.include('/odata/v4/Employees(' + b.id + ')')); pm.environment.set('odEmpId', b.id); pm.environment.set('odEtag', pm.response.headers.get('ETag'));"] }),
  req('PATCH with a stale If-Match → 412', 'PATCH', '/odata/v4/Employees({{odEmpId}})', { headers: { 'Content-Type': 'application/json', 'If-Match': 'W/"stale"' }, body: json({ title: 'x' }), tests: odError(412) }),
  req('PATCH with If-Match → 204', 'PATCH', '/odata/v4/Employees({{odEmpId}})', { headers: { 'Content-Type': 'application/json', 'If-Match': '{{odEtag}}' }, body: json({ title: 'OData tester' }), tests: [status(204)] }),
  req('PATCH return=representation → 200', 'PATCH', '/odata/v4/Employees({{odEmpId}})', { headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: json({ level: 'L2' }), tests: [status(200), "pm.test('merged', () => { const b = pm.response.json(); pm.expect(b.title).to.eql('OData tester'); pm.expect(b.level).to.eql('L2'); });"] }),
  req('DELETE → 204', 'DELETE', '/odata/v4/Employees({{odEmpId}})', { tests: [status(204)] }),
  req('Deleted → 404', 'GET', '/odata/v4/Employees({{odEmpId}})', { tests: odError(404) }),
  req('Unknown property in $filter → 400', 'GET', od('Employees', { $filter: 'colour eq 1' }), { tests: odError(400) }),
  req('Validation → 422 with details', 'POST', '/odata/v4/Departments', { headers: { 'Content-Type': 'application/json' }, body: json({ name: 'Bad', code: 'lower case' }), tests: [...odError(422), "pm.test('details target code', () => pm.expect(pm.response.json().error.details.map((d) => d.target)).to.include('code'));"] }),
  req('X-Force-Error: 503 → OData error', 'GET', '/odata/v4/Employees?$top=1', { headers: { 'X-Force-Error': '503' }, tests: odError(503) }),
]);

// S3-compatible API: every request signs itself with Postman's built-in AWS Signature (awsv4) auth using the
// S3 API keys, so the collection-level auth script leaves these paths alone in every auth mode.
const awsv4 = (secret = '{{s3SecretAccessKey}}') => ({ type: 'awsv4', awsv4: [
  { key: 'accessKey', value: '{{s3AccessKeyId}}', type: 'string' }, { key: 'secretKey', value: secret, type: 'string' },
  { key: 'region', value: '{{s3Region}}', type: 'string' }, { key: 'service', value: 's3', type: 'string' },
] });
const s3req = (name, method, raw, opts = {}) => {
  const item = req(name, method, raw, opts);
  item.request.auth = opts.auth || awsv4();
  return item;
};
const s3Error = (code, s3Code) => [status(code), ctype('application/xml'), has(`S3 error ${s3Code}`, `<Code>${s3Code}</Code>`)];
const s3Body = 'Hello from Postman over the S3 API';
const s3Folder = folder('S3-compatible API', [
  s3req('ListBuckets', 'GET', '/', { tests: [status(200), ctype('application/xml'), "pm.test('bucket listed', () => pm.expect(pm.response.text()).to.include('<Name>' + pm.environment.get('s3Bucket') + '</Name>'));"] }),
  s3req('HeadBucket', 'HEAD', '/{{s3Bucket}}', { tests: [status(200), "pm.test('region header', () => pm.expect(pm.response.headers.get('x-amz-bucket-region')).to.eql(pm.environment.get('s3Region')));"] }),
  s3req('ListObjectsV2 (page of 3)', 'GET', '/{{s3Bucket}}?list-type=2&max-keys=3', { tests: [status(200), has('truncated', '<IsTruncated>true</IsTruncated>'), has('three keys', '<KeyCount>3</KeyCount>'), "const m = /<NextContinuationToken>([^<]+)</.exec(pm.response.text()); pm.test('continuation token', () => pm.expect(m).to.not.eql(null)); pm.environment.set('s3Token', m ? m[1] : '');"] }),
  s3req('ListObjectsV2 (next page)', 'GET', '/{{s3Bucket}}?list-type=2&max-keys=3&continuation-token={{s3Token}}', { tests: [status(200), has('echoes the token', '<ContinuationToken>')] }),
  s3req('PutObject with metadata', 'PUT', '/{{s3Bucket}}/postman/hello.txt', { headers: { 'Content-Type': 'text/plain', 'x-amz-meta-source': 'postman' }, body: rawText(s3Body), tests: [status(200), `pm.test('ETag is the MD5', () => pm.expect(pm.response.headers.get('ETag')).to.eql('"' + require('crypto-js').MD5(${JSON.stringify(s3Body)}).toString() + '"'));`] }),
  s3req('HeadObject', 'HEAD', '/{{s3Bucket}}/postman/hello.txt', { tests: [status(200), `pm.test('length', () => pm.expect(pm.response.headers.get('Content-Length')).to.eql('${Buffer.byteLength(s3Body)}'));`, "pm.test('metadata', () => pm.expect(pm.response.headers.get('x-amz-meta-source')).to.eql('postman'));"] }),
  s3req('GetObject', 'GET', '/{{s3Bucket}}/postman/hello.txt', { tests: [status(200), ctype('text/plain'), `pm.test('body', () => pm.expect(pm.response.text()).to.eql(${JSON.stringify(s3Body)}));`] }),
  s3req('GetObject with Range → 206', 'GET', '/{{s3Bucket}}/postman/hello.txt', { headers: { Range: 'bytes=0-4' }, tests: [status(206), "pm.test('first five bytes', () => pm.expect(pm.response.text()).to.eql('Hello'));", `pm.test('Content-Range', () => pm.expect(pm.response.headers.get('Content-Range')).to.eql('bytes 0-4/${Buffer.byteLength(s3Body)}'));`] }),
  s3req('CopyObject', 'PUT', '/{{s3Bucket}}/postman/copy.txt', { headers: { 'x-amz-copy-source': '/{{s3Bucket}}/postman/hello.txt' }, tests: [status(200), has('CopyObjectResult', '<CopyObjectResult'), has('ETag', '<ETag>')] }),
  s3req('List a "folder" with a delimiter', 'GET', '/{{s3Bucket}}?list-type=2&prefix=postman%2F&delimiter=%2F', { tests: [status(200), has('original', '<Key>postman/hello.txt</Key>'), has('copy', '<Key>postman/copy.txt</Key>')] }),
  req('The copy is in the file pool (/v1/files)', 'GET', '/v1/files?limit=200', { tests: [status(200), "pm.test('listed with its S3 key', () => pm.expect(pm.response.json().data.some((f) => f.s3 && f.s3.key === 'postman/copy.txt')).to.eql(true));"] }),
  s3req('DeleteObjects', 'POST', '/{{s3Bucket}}?delete', { headers: { 'Content-Type': 'application/xml' }, body: rawText('<Delete><Object><Key>postman/hello.txt</Key></Object><Object><Key>postman/copy.txt</Key></Object></Delete>'), tests: [status(200), has('deleted', '<Deleted><Key>postman/hello.txt</Key></Deleted>')] }),
  s3req('Deleted → 404 NoSuchKey', 'GET', '/{{s3Bucket}}/postman/hello.txt', { tests: s3Error(404, 'NoSuchKey') }),
  s3req('Unknown bucket → 404 NoSuchBucket', 'GET', '/no-such-bucket?list-type=2', { tests: s3Error(404, 'NoSuchBucket') }),
  s3req('Wrong secret → 403 SignatureDoesNotMatch', 'GET', '/{{s3Bucket}}?list-type=2', { auth: awsv4('not-the-secret'), tests: s3Error(403, 'SignatureDoesNotMatch') }),
  s3req('Unsigned → 403 AccessDenied', 'GET', '/{{s3Bucket}}/employees.csv', { auth: { type: 'noauth' }, tests: s3Error(403, 'AccessDenied') }),
  s3req('X-Force-Error: 503 → S3 XML error', 'GET', '/{{s3Bucket}}?list-type=2', { headers: { 'X-Force-Error': '503' }, tests: s3Error(503, 'ServiceUnavailable') }),
], 'The file pool as an S3 bucket (path-style). Requests use Postman\'s AWS Signature auth with {{s3AccessKeyId}}, {{s3SecretAccessKey}} and {{s3Region}}, independent of {{authMode}}.');

const misc = folder('Headers & inspector', [
  req('Request id echo', 'GET', '/v1/employees/1', { headers: { 'X-Request-Id': 'postman-req-1', 'X-Correlation-Id': 'postman-corr-1' }, tests: [status(200), "pm.test('echoed', () => { pm.expect(pm.response.headers.get('X-Request-Id')).to.eql('postman-req-1'); pm.expect(pm.response.headers.get('X-Correlation-Id')).to.eql('postman-corr-1'); });"] }),
  req('Inspector catch-all', 'POST', '/hooks/postman?source=newman', { headers: { 'Content-Type': 'application/json' }, body: json({ event: 'order.created', id: 42 }), tests: [status(200), "pm.test('captured with actual path', () => { pm.expect(pm.response.json().status).to.eql('captured'); pm.expect(pm.response.json().path).to.eql((pm.environment.get('baseUrl').match(/^https?:\\/\\/[^/]+(\\/.*?)?\\/?$/)[1] || '') + '/hooks/postman'); });"] }),
]);

const collection = {
  info: {
    _postman_id: 'b1f0d7c8-1a2b-4c3d-9e8f-api-test-tool',
    name: 'API Test Tool',
    description: 'Covers every endpoint and feature of lbrenman/api-test-tool. Set {{authMode}} in the environment to match the server\'s AUTH_MODE; the collection pre-request script authenticates /v1 calls. Generated by scripts/build-postman.js.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  event: [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: collectionPre } },
    { listen: 'test', script: { type: 'text/javascript', exec: collectionTest } },
  ],
  variable: [{ key: 'cachedToken', value: '' }, { key: 'cachedTokenExp', value: '0' }],
  item: [platform, oauth, assertions, authFolder, crud, query, pagination, chaos, files, soapFolder, sseFolder, llmFolder, mcpFolder, a2aFolder, graphqlFolder, odataFolder, s3Folder, misc],
};

const environment = {
  id: 'c7d0f2a1-api-test-tool-env',
  name: 'API Test Tool (local)',
  values: [
    ['baseUrl', 'http://localhost:3000'], ['authMode', 'none'],
    ['apiKey', 'demo-key'], ['apiKeyName', 'X-API-Key'], ['apiKeyIn', 'header'],
    ['basicUser', 'demo'], ['basicPass', 'demo'], ['bearerToken', 'demo-token'],
    ['clientId', 'demo-client'], ['clientSecret', 'demo-secret'], ['scope', 'read write'],
    ['hmacKeyId', 'demo'], ['hmacSecret', 'demo-hmac'],
    ['s3Bucket', 'files'], ['s3Region', 'us-east-1'], ['s3AccessKeyId', 'demo-access-key'], ['s3SecretAccessKey', 'demo-secret-key'],
  ].map(([key, value]) => ({ key, value, type: /secret|pass|key$/i.test(key) && key !== 'apiKeyName' ? 'secret' : 'default', enabled: true })),
  _postman_variable_scope: 'environment',
};

fs.mkdirSync(path.join(OUT, 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'API-Test-Tool.postman_collection.json'), `${JSON.stringify(collection, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'API-Test-Tool.postman_environment.json'), `${JSON.stringify(environment, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'fixtures', 'hello.txt'), 'Hello from the API Test Tool fixture.\nUsed by the multipart upload request.\n');
const count = (items) => items.reduce((n, i) => n + (i.item ? count(i.item) : 1), 0);
console.log(`Wrote collection with ${count(collection.item)} requests to ${OUT}`);
