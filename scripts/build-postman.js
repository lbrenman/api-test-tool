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
  "const p = resolved.getPath();",
  "const isApi = p.indexOf('/v1/') === 0 && p.indexOf('/v1/files/presigned/') !== 0;",
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
  '// Applies the auth mode in {{authMode}} to /v1 requests. Requests with header X-Skip-Auth: 1 go out unauthenticated.',
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
  req('OpenAPI JSON', 'GET', '/openapi.json', { tests: [status(200), "pm.test('3.1', () => pm.expect(pm.response.json().openapi).to.eql('3.1.0'));", "pm.test('auth mode reflected', () => { const s = pm.response.json().components.securitySchemes; const m = pm.environment.get('authMode'); if (m === 'none') pm.expect(Object.keys(s)).to.have.length(0); else pm.expect(Object.keys(s)).to.have.length(1); });", "pm.test('data API only (no admin or health paths)', () => pm.expect(Object.keys(pm.response.json().paths).filter((p) => !p.startsWith('/v1/') && !p.startsWith('/oauth/'))).to.have.length(0));"] }),
  req('OpenAPI YAML', 'GET', '/openapi.yaml', { tests: [status(200), "pm.test('yaml', () => pm.expect(pm.response.text()).to.include('openapi: 3.1.0'));"] }),
  req('OpenAPI JSON (admin API)', 'GET', '/admin/api/openapi.json', {
    description: 'The admin / control-plane spec. Needs the dashboard password when ADMIN_PASSWORD is set (401 otherwise).',
    tests: [
      "pm.test('200 or 401 (password set)', () => pm.expect([200, 401]).to.include(pm.response.code));",
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
]);

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
function walker(name, raw, { step }) {
  return req(name, 'GET', raw, {
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

const misc = folder('Headers & inspector', [
  req('Request id echo', 'GET', '/v1/employees/1', { headers: { 'X-Request-Id': 'postman-req-1', 'X-Correlation-Id': 'postman-corr-1' }, tests: [status(200), "pm.test('echoed', () => { pm.expect(pm.response.headers.get('X-Request-Id')).to.eql('postman-req-1'); pm.expect(pm.response.headers.get('X-Correlation-Id')).to.eql('postman-corr-1'); });"] }),
  req('Inspector catch-all', 'POST', '/hooks/postman?source=newman', { headers: { 'Content-Type': 'application/json' }, body: json({ event: 'order.created', id: 42 }), tests: [status(200), "pm.test('captured with actual path', () => { pm.expect(pm.response.json().status).to.eql('captured'); pm.expect(pm.response.json().path).to.eql('/hooks/postman'); });"] }),
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
  item: [platform, oauth, authFolder, crud, query, pagination, chaos, files, misc],
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
  ].map(([key, value]) => ({ key, value, type: /secret|pass|key$/i.test(key) && key !== 'apiKeyName' ? 'secret' : 'default', enabled: true })),
  _postman_variable_scope: 'environment',
};

fs.mkdirSync(path.join(OUT, 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'API-Test-Tool.postman_collection.json'), `${JSON.stringify(collection, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'API-Test-Tool.postman_environment.json'), `${JSON.stringify(environment, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'fixtures', 'hello.txt'), 'Hello from the API Test Tool fixture.\nUsed by the multipart upload request.\n');
const count = (items) => items.reduce((n, i) => n + (i.item ? count(i.item) : 1), 0);
console.log(`Wrote collection with ${count(collection.item)} requests to ${OUT}`);
