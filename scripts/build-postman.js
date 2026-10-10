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
  "const isApi = (p.indexOf('/v1/') === 0 && p.indexOf('/v1/files/presigned/') !== 0) || (p.indexOf('/soap/') === 0 && pm.request.method === 'POST') || p.indexOf('/sse/') === 0 || p === '/graphql' || (p.indexOf('/odata/v4/') === 0 && p !== '/odata/v4/' && p !== '/odata/v4/$metadata');",
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
  '// Applies the auth mode in {{authMode}} to /v1 requests, SOAP POSTs, SSE streams, /graphql and OData. Requests with header X-Skip-Auth: 1 go out unauthenticated.',
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
  req('OpenAPI JSON', 'GET', '/openapi.json', { tests: [status(200), "pm.test('3.1', () => pm.expect(pm.response.json().openapi).to.eql('3.1.0'));", "pm.test('auth mode reflected', () => { const s = pm.response.json().components.securitySchemes; const m = pm.environment.get('authMode'); if (m === 'none') pm.expect(Object.keys(s)).to.have.length(0); else pm.expect(Object.keys(s)).to.have.length(1); });", "pm.test('data API only (no admin or health paths)', () => pm.expect(Object.keys(pm.response.json().paths).filter((p) => !p.startsWith('/v1/') && !p.startsWith('/oauth/') && !p.startsWith('/sse/'))).to.have.length(0));"] }),
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
  item: [platform, oauth, authFolder, crud, query, pagination, chaos, files, soapFolder, sseFolder, graphqlFolder, odataFolder, s3Folder, misc],
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
