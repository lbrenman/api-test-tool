'use strict';
// Dashboard component guides: the curl commands must follow the active auth mode and be runnable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const win = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'guides.js'), 'utf8'), { window: win });
const { makeCurl, build, fromSentRequest } = win.ATT_GUIDES;

const BASE_CTX = {
  base: 'https://att.example.dev',
  apiKey: { name: 'X-API-Key', in: 'header', value: 'demo-key' },
  basic: { user: 'demo', pass: 'demo' },
  bearer: 'demo-token',
  hmac: { keyId: 'demo', secret: "s3cr'et" },
  tokenUrl: 'https://att.example.dev/oauth/token',
  client: { clientId: 'demo-client', secret: 'demo-secret' },
  required: [],
  adminPasswordRequired: false,
};
const MODES = ['none', 'apikey', 'basic', 'bearer', 'jwt', 'oauth2', 'hmac'];
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
const hasOpenssl = hasBash && spawnSync('bash', ['-c', 'command -v openssl']).status === 0;

test('curl examples carry the credentials of the active auth mode', () => {
  const url = '/v1/employees?limit=2';
  const c = (mode, extra = {}) => makeCurl({ ...BASE_CTX, mode, ...extra }).curl('GET', url);
  assert.doesNotMatch(c('none'), /Authorization|X-API-Key|-u /);
  assert.match(c('apikey'), /-H 'X-API-Key: demo-key'/);
  assert.match(c('apikey', { apiKey: { name: 'api_key', in: 'query', value: 'k' } }), /employees\?limit=2&api_key=k'/);
  assert.match(c('basic'), /-u 'demo:demo'/);
  assert.match(c('bearer'), /Authorization: Bearer demo-token/);
  for (const m of ['jwt', 'oauth2']) {
    const cmd = c(m);
    assert.match(cmd, /^TOKEN=\$\(curl -s -u 'demo-client:demo-secret' -d grant_type=client_credentials 'https:\/\/att\.example\.dev\/oauth\/token'/);
    assert.match(cmd, /Authorization: Bearer \$TOKEN/);
  }
  assert.match(c('hmac'), /Authorization: HMAC demo:\$SIG/);
  // Non-/v1 calls never carry API credentials.
  assert.doesNotMatch(makeCurl({ ...BASE_CTX, mode: 'bearer' }).curl('POST', '/hooks/x', { json: { a: 1 } }), /Authorization/);
});

test('SOAP requests carry credentials; the WSDL and service list do not', () => {
  const C = makeCurl({ ...BASE_CTX, mode: 'bearer' });
  assert.match(C.curl('POST', '/soap/EmployeeService', { body: '<x/>', contentType: 'text/xml' }), /Authorization: Bearer demo-token/);
  assert.doesNotMatch(C.curl('GET', '/soap/EmployeeService?wsdl'), /Authorization/);
  assert.doesNotMatch(C.curl('GET', '/soap/ProductService.wsdl'), /Authorization/);
  assert.doesNotMatch(C.curl('GET', '/soap'), /Authorization/);
  const g = build(makeCurl({ ...BASE_CTX, mode: 'basic' }), {});
  for (const id of ['protocols.soap', 'protocols.soap-settings', 'protocols.soap-try']) assert.ok(g[id], `guide ${id}`);
  assert.match(g['protocols.soap'].curls.find(([l]) => /GetEmployee/.test(l))[1], /-u 'demo:demo'[\s\S]*SOAPAction/);
});

test('required request headers are added to /v1 calls only', () => {
  const C = makeCurl({ ...BASE_CTX, mode: 'none', required: [{ name: 'X-Tenant' }, { name: 'X-Env', value: 'demo' }] });
  const cmd = C.curl('GET', '/v1/products');
  assert.match(cmd, /X-Tenant: test/);
  assert.match(cmd, /X-Env: demo/);
  assert.doesNotMatch(C.plain('GET', '/health'), /X-Tenant/);
});

test('admin API examples use the dashboard password only when one is set', () => {
  assert.match(makeCurl({ ...BASE_CTX, mode: 'none', adminPasswordRequired: true }).admin('GET', '/settings'), /-u "admin:\$ADMIN_PASSWORD"/);
  assert.doesNotMatch(makeCurl({ ...BASE_CTX, mode: 'none' }).admin('GET', '/settings'), /ADMIN_PASSWORD/);
});

test('every guide has steps and every curl is valid shell, in every auth mode', { skip: !hasBash && 'bash not available' }, () => {
  for (const mode of MODES) {
    const guides = build(makeCurl({ ...BASE_CTX, mode, required: [{ name: 'X-Tenant' }] }), { specId: 'abc', firstOpId: 'GET /purchase-orders', fileId: 'f1' });
    assert.ok(Object.keys(guides).length >= 30);
    for (const [id, g] of Object.entries(guides)) {
      assert.ok(g.title && g.purpose && g.steps.length, `${id} needs a title, purpose and steps`);
      for (const [label, cmd] of g.curls) {
        const r = spawnSync('bash', ['-n', '-c', cmd]);
        assert.equal(r.status, 0, `${mode} ${id} "${label}" is not valid shell: ${r.stderr}`);
      }
    }
  }
});

test('the HMAC snippet signs exactly like the server', { skip: !hasOpenssl && 'openssl not available' }, () => {
  const C = makeCurl({ ...BASE_CTX, mode: 'hmac' });
  const ts = '1700000000';
  const serverSig = (method, url, bodyHash) => crypto.createHmac('sha256', BASE_CTX.hmac.secret).update([method, url, ts, bodyHash].join('\n')).digest('base64');
  const body = { name: "O'Brien", code: 'RND' };
  const cases = [
    ['GET', '/v1/employees?limit=2', {}, crypto.createHash('sha256').update('').digest('hex')],
    ['POST', '/v1/departments', { json: body }, crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')],
    ['POST', '/v1/files/multipart', { form: ['file=@x'] }, 'UNSIGNED-PAYLOAD'],
  ];
  for (const [method, url, opts, hash] of cases) {
    const script = C.curl(method, url, opts).split('\n').filter((l) => /^(BODY|TS|SIG)=/.test(l)).join('\n').replace('TS=$(date +%s)', `TS=${ts}`);
    const sig = execFileSync('bash', ['-c', `${script}\nprintf %s "$SIG"`]).toString();
    assert.equal(sig, serverSig(method, url, hash), `${method} ${url}`);
  }
});

test('a request the tester sent can be copied as curl', () => {
  const cmd = fromSentRequest({ method: 'POST', url: 'https://api.example.com/v1/orders', headers: { 'Content-Type': 'application/json', 'Content-Length': '9', 'X-API-Key': 'k' }, body: { a: "it's" } });
  assert.match(cmd, /-X POST/);
  assert.match(cmd, /-H 'X-API-Key: k'/);
  assert.doesNotMatch(cmd, /Content-Length/);
  assert.match(cmd, /--data-binary '\{"a":"it'\\''s"\}'/);
});
