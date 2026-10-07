'use strict';
// The two generated OpenAPI documents: the mock data API (/openapi.json, for integrations) and the admin API
// (/admin/api/openapi.json, for operators). They must not overlap, must be valid, and must stay in sync with the routes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const SwaggerParser = require('@apidevtools/swagger-parser');
const { makeApp } = require('./helpers');

const basic = (pw) => `Basic ${Buffer.from(`admin:${pw}`).toString('base64')}`;

// Routes declared on the admin and tester routers, as OpenAPI paths (":id" -> "{id}").
function declaredAdminRoutes() {
  const out = [];
  const scan = (file, prefix) => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', file), 'utf8');
    for (const m of src.matchAll(/\br\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      out.push({ method: m[1], path: `${prefix}${m[2]}`.replace(/:([A-Za-z]+)/g, '{$1}') });
    }
  };
  scan('admin.js', '/admin/api');
  scan('tester.js', '/admin/api/tester');
  scan('appApi.js', '/admin/api/app');
  return out;
}

test('data spec covers /v1 and OAuth only; admin and health live in the admin spec', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  try {
    const data = (await request(t.app).get('/openapi.json').expect(200)).body;
    const admin = (await request(t.app).get('/admin/api/openapi.json').expect(200)).body;
    const dataPaths = Object.keys(data.paths);
    assert.ok(dataPaths.includes('/v1/employees'));
    assert.ok(dataPaths.includes('/oauth/token'));
    assert.ok(dataPaths.every((p) => p.startsWith('/v1/') || p.startsWith('/oauth/')), `unexpected data paths: ${dataPaths.filter((p) => !p.startsWith('/v1/') && !p.startsWith('/oauth/'))}`);
    assert.match(data.info.title, /Mock Data API/);
    assert.match(data.info.description, /\/admin\/api\/openapi\.json/);

    const adminPaths = Object.keys(admin.paths);
    for (const p of ['/health', '/ready', '/admin/api/settings', '/admin/api/data/seed', '/admin/api/inspector', '/admin/api/tester/specs']) assert.ok(adminPaths.includes(p), p);
    assert.ok(!adminPaths.some((p) => p.startsWith('/v1')), 'admin spec must not describe /v1');
    assert.match(admin.info.title, /Admin API/);
    assert.match(admin.info.description, /\/openapi\.json/);
    assert.deepEqual(Object.keys(admin.components.securitySchemes).sort(), ['AdminBasic', 'AdminSession']);
    assert.deepEqual(admin.paths['/health'].get.security, []);

    // The admin spec does not follow the /v1 auth mode.
    await t.ctx.settings.set('authMode', 'oauth2');
    const admin2 = (await request(t.app).get('/admin/api/openapi.json')).body;
    assert.deepEqual(Object.keys(admin2.components.securitySchemes).sort(), ['AdminBasic', 'AdminSession']);
    assert.ok((await request(t.app).get('/openapi.json')).body.components.securitySchemes.OAuth2);

    const y = await request(t.app).get('/admin/api/openapi.yaml').expect(200);
    assert.match(y.headers['content-type'], /yaml/);
    assert.match(y.text, /title: API Test Tool — Admin API/);
  } finally { await t.close(); }
});

test('both specs are valid OpenAPI 3.1', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', AUTH_MODE: 'oauth2', REQUIRED_HEADERS: 'X-Tenant' });
  try {
    for (const url of ['/openapi.json', '/admin/api/openapi.json']) {
      const doc = (await request(t.app).get(url).expect(200)).body;
      await assert.doesNotReject(SwaggerParser.validate(structuredClone(doc), { resolve: { external: false }, validate: { spec: true, schema: true } }), url);
    }
  } finally { await t.close(); }
});

test('every admin and tester route is documented in the admin spec', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  try {
    const admin = (await request(t.app).get('/admin/api/openapi.json')).body;
    const missing = declaredAdminRoutes().filter((r) => !admin.paths[r.path]?.[r.method]);
    assert.deepEqual(missing, [], `undocumented admin routes: ${missing.map((r) => `${r.method.toUpperCase()} ${r.path}`).join(', ')}`);
    const ids = Object.values(admin.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    assert.equal(new Set(ids).size, ids.length, 'operationIds must be unique');
  } finally { await t.close(); }
});

test('admin spec and its Swagger UI tab need the dashboard password when one is set', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', ADMIN_PASSWORD: 's3cret' });
  try {
    await request(t.app).get('/admin/api/openapi.json').expect(401);
    await request(t.app).get('/admin/api/openapi.yaml').expect(401);
    const ok = await request(t.app).get('/admin/api/openapi.json').set('Authorization', basic('s3cret')).expect(200);
    assert.match(ok.body.info.title, /Admin API/);
    assert.doesNotMatch(ok.body.info.description, /currently open/);
    await request(t.app).get('/openapi.json').expect(200); // the data spec stays open

    const docs = await request(t.app).get('/docs').expect(200);
    assert.match(docs.text, /url: '\/openapi\.json'/);
    assert.match(docs.text, /Mock Data API/);
    assert.match(docs.text, /Admin API/);
    const gated = await request(t.app).get('/docs?spec=admin').expect(200);
    assert.doesNotMatch(gated.text, /SwaggerUIBundle/);
    assert.match(gated.text, /Sign in to the/);
    const adminDocs = await request(t.app).get('/docs?spec=admin').set('Authorization', basic('s3cret')).expect(200);
    assert.match(adminDocs.text, /url: '\/admin\/api\/openapi\.json'/);
  } finally { await t.close(); }
});

test('admin spec says so when the admin API is open', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  try {
    const admin = (await request(t.app).get('/admin/api/openapi.json').expect(200)).body;
    assert.match(admin.info.description, /ADMIN_PASSWORD is not set/);
  } finally { await t.close(); }
});
