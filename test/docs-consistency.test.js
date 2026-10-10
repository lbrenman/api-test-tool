'use strict';
// Keeps the documentation from drifting behind the code:
//   - every setting in DEFS is documented in .env.example and the README env table
//   - every protocol that /health reports is described in the dashboard help, has an Inspector source,
//     a row in the help page's reserved-paths table and a README section
// When one of these fails, update the docs named in the message (see the project instructions' checklist).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { DEFS } = require('../src/config/settings');
const { apiKind } = require('../src/middleware/inspector');
const { makeApp } = require('./helpers');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('every setting is documented in .env.example and the README env table', () => {
  const env = read('.env.example');
  const readme = read('README.md');
  const missingEnv = DEFS.filter((d) => !new RegExp(`^#?\\s*${d.env}=`, 'm').test(env)).map((d) => d.env);
  const missingReadme = DEFS.filter((d) => !readme.includes(`\`${d.env}\``)).map((d) => d.env);
  assert.deepEqual(missingEnv, [], `add these to .env.example: ${missingEnv.join(', ')}`);
  assert.deepEqual(missingReadme, [], `add these to the README env table: ${missingReadme.join(', ')}`);
});

// How each protocol reported by /health shows up in the dashboard and docs.
const PROTOCOLS = {
  soap: { name: 'SOAP', kind: 'soap', samplePath: '/soap/EmployeeService', reserved: '/soap', readme: '## SOAP services' },
  websocket: { name: 'WebSocket', kind: 'ws', samplePath: '/ws/echo', reserved: '/ws', readme: '## WebSocket channels' },
  sse: { name: 'Server-Sent Events', kind: 'sse', samplePath: '/sse/changes', reserved: '/sse', readme: '## Server-Sent Events' },
  graphql: { name: 'GraphQL', kind: 'graphql', samplePath: '/graphql', reserved: '/graphql', readme: '## GraphQL' },
  odata: { name: 'OData', kind: 'odata', samplePath: '/odata/v4/Employees', reserved: '/odata/v4', readme: '## OData v4' },
  s3: { name: 'S3', kind: 's3', reserved: '(the S3 bucket name)', readme: '## S3-compatible API' },
};
const NOT_PROTOCOLS = ['authMode', 'dateFormat', 'errorRate', 'errorTypes', 'latencyMs', 'rateLimitRpm', 'requiredHeaders', 'responseHeaders', 'inspectorLogAll', 'maxFileSizeMb', 'dashboardProtected', 'webhooks'];

test('every protocol in /health is described in the help, the Inspector filter, reserved paths and the README', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  let health;
  try {
    health = (await request(t.app).get('/health').expect(200)).body;
  } finally {
    await t.close();
  }
  const reported = Object.keys(health.settings).filter((k) => !NOT_PROTOCOLS.includes(k));
  const unknown = reported.filter((k) => !PROTOCOLS[k]);
  assert.deepEqual(unknown, [], `/health reports protocols this test does not know: ${unknown.join(', ')}. Add them to PROTOCOLS here (and their docs), or to NOT_PROTOCOLS if they are not protocols.`);

  const app = read('src/public/app.js');
  const readme = read('README.md');
  const protocolsHelp = /protocols: \{ purpose: '([^']+)' \}/.exec(app)?.[1] || '';
  const inspectorHelp = /inspector: \{ purpose: '([^']+)' \}/.exec(app)?.[1] || '';
  const reservedTable = app.slice(app.indexOf("section('urls'"), app.indexOf("section('pages'"));
  for (const [key, p] of Object.entries(PROTOCOLS)) {
    assert.ok(reported.includes(key), `${key} is listed here but /health does not report it`);
    assert.ok(protocolsHelp.includes(p.name), `PAGE_HELP.protocols should mention ${p.name}`);
    assert.ok(app.includes(`['${p.kind}', `), `the Inspector source filter should offer "${p.kind}"`);
    if (p.samplePath) assert.equal(apiKind(p.samplePath), p.kind, `middleware/inspector.js apiKind should tag ${p.samplePath} as ${p.kind}`);
    assert.ok(reservedTable.includes(p.reserved), `the help page's reserved-paths table should list ${p.reserved}`);
    assert.ok(readme.includes(p.readme), `the README should have a "${p.readme}" section`);
  }
  for (const name of ['SOAP', 'WebSocket', 'SSE', 'GraphQL', 'OData', 'S3']) {
    assert.ok(inspectorHelp.includes(name), `PAGE_HELP.inspector should mention ${name}`);
  }
});
