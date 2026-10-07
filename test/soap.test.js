'use strict';
// Mock SOAP services (/soap): WSDL, operations over the shared data, faults, SOAPAction, WS-Security,
// and the shared protocol stack (AUTH_MODE, chaos) rendering SOAP faults.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { parseXml, child, elements, textOf, NS } = require('../src/protocols/soap/xml');
const { passwordDigest, TYPE_DIGEST } = require('../src/protocols/soap/wsse');

const EMP_NS = 'urn:api-test-tool:soap:EmployeeService';
const PROD_NS = 'urn:api-test-tool:soap:ProductService';

let t;
before(async () => { t = await makeApp({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.close(); });

const asText = (res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d)); };
const set = (k, v) => t.ctx.settings.set(k, v);

function env(inner, { version = '1.1', header = '', ns = EMP_NS } = {}) {
  const soapNs = version === '1.2' ? NS.soap12 : NS.soap11;
  return `<?xml version="1.0"?><s:Envelope xmlns:s="${soapNs}" xmlns:e="${ns}"><s:Header>${header}</s:Header><s:Body>${inner}</s:Body></s:Envelope>`;
}

// POST an operation; returns { res, doc, body (first element in Body), fault }
async function call(op, inner = '', o = {}) {
  const { version = '1.1', service = 'EmployeeService', action, headers = {}, raw, contentType } = o;
  const ns = service === 'ProductService' ? PROD_NS : EMP_NS;
  const xml = raw ?? env(`<e:${op}>${inner}</e:${op}>`, { version, header: o.header, ns });
  let req = request(t.app).post(`/soap/${service}`).buffer(true).parse(asText);
  const act = action === undefined ? `${ns}/${op}` : action;
  if (version === '1.2') req = req.set('Content-Type', contentType || `application/soap+xml; charset=utf-8${act !== null ? `; action="${act}"` : ''}`);
  else {
    req = req.set('Content-Type', contentType || 'text/xml; charset=utf-8');
    if (act !== null) req = req.set('SOAPAction', `"${act}"`);
  }
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  const res = await req.send(xml);
  let doc = null;
  try { doc = parseXml(res.body); } catch { /* not XML */ }
  const bodyEl = doc && elements(doc).find((e) => e.local === 'Body');
  const first = bodyEl ? elements(bodyEl)[0] : null;
  return { res, doc, body: first, fault: first && first.local === 'Fault' ? first : null };
}

// Fault summary: code (1.1 faultcode or 1.2 Code/Value), subcode, f:faultDetail/f:code
function faultInfo(fault) {
  const det = (d) => d && child(d, 'faultDetail', NS.faults);
  if (child(fault, 'faultcode')) {
    const d = det(child(fault, 'detail'));
    return { code: textOf(child(fault, 'faultcode')), text: textOf(child(fault, 'faultstring')), detailCode: textOf(child(d, 'code', NS.faults)), detail: d };
  }
  const code = child(fault, 'Code', NS.soap12);
  const d = det(child(fault, 'Detail', NS.soap12));
  return {
    code: textOf(child(code, 'Value', NS.soap12)),
    subcode: textOf(child(child(code, 'Subcode', NS.soap12), 'Value', NS.soap12)),
    text: textOf(child(child(fault, 'Reason', NS.soap12), 'Text', NS.soap12)),
    detailCode: textOf(child(d, 'code', NS.faults)),
    detail: d,
  };
}

const val = (el, ...path) => { let e = el; for (const p of path) e = child(e, p); return textOf(e); };

test('service list and WSDL', async () => {
  const list = await request(t.app).get('/soap').expect(200);
  assert.deepEqual(list.body.services.map((s) => s.name), ['EmployeeService', 'ProductService']);
  assert.match(list.body.services[0].wsdl, /^http:\/\/localhost\/soap\/EmployeeService\?wsdl$/);

  const w = await request(t.app).get('/soap/EmployeeService?wsdl').buffer(true).parse(asText).expect(200);
  assert.match(w.get('Content-Type'), /text\/xml/);
  const wsdl = parseXml(w.body);
  assert.equal(wsdl.local, 'definitions');
  assert.equal(wsdl.attrs.find((a) => a.local === 'targetNamespace').value, EMP_NS);
  assert.deepEqual(elements(wsdl, 'binding', NS.wsdl).map((b) => b.attrs.find((a) => a.local === 'name').value), ['EmployeeServiceSoap11', 'EmployeeServiceSoap12']);
  const ops = elements(child(wsdl, 'portType', NS.wsdl), 'operation').map((o) => o.attrs.find((a) => a.local === 'name').value);
  for (const op of ['GetEmployee', 'ListEmployees', 'CreateEmployee', 'UpdateEmployee', 'DeleteEmployee', 'GetDepartment', 'ListDepartments']) assert.ok(ops.includes(op), op);
  assert.match(w.body, /location="http:\/\/localhost\/soap\/EmployeeService"/);
  assert.match(w.body, /soapAction="urn:api-test-tool:soap:EmployeeService\/GetEmployee"/);

  await request(t.app).get('/soap/ProductService.wsdl').expect(200);
  const nf = await request(t.app).get('/soap/Nope?wsdl').buffer(true).parse(asText).expect(404);
  assert.match(nf.body, /faultcode>soap:Client</);
  await request(t.app).get('/soap/EmployeeService').expect(405);
});

test('GetEmployee over SOAP 1.1 and 1.2 returns the same record as /v1', async () => {
  const rest = (await request(t.app).get('/v1/employees/1').expect(200)).body;
  const a = await call('GetEmployee', '<e:id>1</e:id>');
  assert.equal(a.res.status, 200);
  assert.match(a.res.get('Content-Type'), /^text\/xml/);
  assert.equal(a.res.get('X-Soap-Operation'), 'GetEmployee');
  assert.equal(a.body.local, 'GetEmployeeResponse');
  assert.equal(a.body.ns, EMP_NS);
  const emp = child(a.body, 'employee', EMP_NS);
  assert.equal(val(emp, 'id'), '1');
  assert.equal(val(emp, 'email'), rest.email);
  assert.equal(val(emp, 'salary'), rest.salaryDecimal);
  assert.equal(val(emp, 'department', 'name'), rest.department.name);
  assert.equal(elements(child(emp, 'skills')).length, rest.skills.length);

  const b = await call('GetEmployee', '<e:id>1</e:id>', { version: '1.2' });
  assert.equal(b.res.status, 200);
  assert.match(b.res.get('Content-Type'), /^application\/soap\+xml/);
  assert.equal(b.doc.ns, NS.soap12);
});

test('ListEmployees pages and filters; ListDepartments and ProductService work', async () => {
  const all = await call('ListEmployees', '<e:page>2</e:page><e:pageSize>5</e:pageSize>');
  assert.equal(val(all.body, 'page'), '2');
  assert.equal(elements(child(all.body, 'employees')).length, 5);
  assert.equal(Number(val(all.body, 'totalItems')), (await t.ctx.resources.all('employees')).length);

  const deptId = (await t.ctx.resources.all('employees'))[0].departmentId;
  const f = await call('ListEmployees', `<e:departmentId>${deptId}</e:departmentId><e:pageSize>200</e:pageSize>`);
  for (const e of elements(child(f.body, 'employees'))) assert.equal(val(e, 'departmentId'), String(deptId));

  const bad = await call('ListEmployees', '<e:pageSize>500</e:pageSize>');
  assert.equal(faultInfo(bad.fault).detailCode, 'invalid-paging');

  const d = await call('ListDepartments');
  assert.ok(elements(child(d.body, 'departments')).length > 0);

  const p = await call('GetProduct', '<e:id>1</e:id>', { service: 'ProductService' });
  assert.equal(val(child(p.body, 'product', PROD_NS), 'id'), '1');
  const c = await call('ListCategories', '', { service: 'ProductService' });
  assert.ok(elements(child(c.body, 'categories')).length > 0);
});

test('Create, Update and Delete go through the same validation as /v1', async () => {
  const deptId = (await t.ctx.resources.all('departments'))[0].id;
  const created = await call('CreateEmployee', `<e:employee><e:firstName>Ada</e:firstName><e:lastName>Lovelace</e:lastName>
    <e:email>ada@example.com</e:email><e:departmentId>${deptId}</e:departmentId><e:isActive>true</e:isActive><e:salary>91000.5</e:salary>
    <e:skills><e:skill>math</e:skill><e:skill>engines</e:skill></e:skills><e:managerId xsi:nil="true" xmlns:xsi="${NS.xsi}"/></e:employee>`);
  assert.equal(created.res.status, 200, created.res.body);
  const emp = child(created.body, 'employee');
  const id = Number(val(emp, 'id'));
  assert.equal(val(emp, 'salary'), '91000.50');
  assert.equal((await request(t.app).get(`/v1/employees/${id}`).expect(200)).body.skills.join(','), 'math,engines');

  const upd = await call('UpdateEmployee', `<e:id>${id}</e:id><e:employee><e:title>Analyst</e:title></e:employee>`);
  assert.equal(val(child(upd.body, 'employee'), 'title'), 'Analyst');
  assert.equal(val(child(upd.body, 'employee'), 'firstName'), 'Ada');

  const del = await call('DeleteEmployee', `<e:id>${id}</e:id>`);
  assert.equal(val(del.body, 'deleted'), 'true');

  const gone = await call('GetEmployee', `<e:id>${id}</e:id>`);
  assert.equal(gone.res.status, 500); // SOAP 1.1: every fault is HTTP 500
  const g = faultInfo(gone.fault);
  assert.equal(g.code, 'soap:Client');
  assert.equal(g.detailCode, 'not-found');

  const gone12 = await call('GetEmployee', `<e:id>${id}</e:id>`, { version: '1.2' });
  assert.equal(gone12.res.status, 400); // SOAP 1.2: Sender faults are HTTP 400
  const g12 = faultInfo(gone12.fault);
  assert.equal(g12.code, 'soap:Sender');
  assert.equal(g12.subcode, 'f:NotFound');
});

test('invalid requests become Client/Sender faults with field errors', async () => {
  const missing = await call('CreateEmployee', '<e:employee><e:firstName>X</e:firstName></e:employee>');
  const m = faultInfo(missing.fault);
  assert.equal(m.detailCode, 'validation-failed');
  const fields = elements(child(m.detail, 'errors', NS.faults)).map((e) => e.attrs.find((a) => a.local === 'field').value);
  assert.ok(fields.includes('lastName') && fields.includes('email'), fields.join(','));

  const typed = await call('GetEmployee', '<e:id>abc</e:id>');
  assert.equal(faultInfo(typed.fault).detailCode, 'invalid-request');
  const extra = await call('GetEmployee', '<e:id>1</e:id><e:bogus>1</e:bogus>');
  assert.equal(faultInfo(extra.fault).detailCode, 'invalid-request');
  const ro = await call('CreateEmployee', '<e:employee><e:id>5</e:id></e:employee>');
  assert.equal(faultInfo(ro.fault).detailCode, 'invalid-element');

  const unknown = await call('FireEveryone', '', { action: null });
  assert.equal(faultInfo(unknown.fault).detailCode, 'unknown-operation');

  const wrongNs = await call('GetEmployee', '', { raw: env('<GetEmployee xmlns="urn:other"><id>1</id></GetEmployee>'), action: null });
  assert.equal(faultInfo(wrongNs.fault).detailCode, 'wrong-namespace');

  const malformed = await call('GetEmployee', '', { raw: '<s:Envelope xmlns:s="x"><oops>' });
  assert.equal(malformed.res.status, 500);
  assert.equal(faultInfo(malformed.fault).detailCode, 'malformed-xml');

  const dtd = await call('GetEmployee', '', { raw: '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x/>' });
  assert.equal(faultInfo(dtd.fault).detailCode, 'malformed-xml');

  const notEnv = await call('GetEmployee', '', { raw: '<hello/>' });
  assert.equal(faultInfo(notEnv.fault).detailCode, 'not-a-soap-envelope');

  const vm = await call('GetEmployee', '', { raw: env('<e:GetEmployee><e:id>1</e:id></e:GetEmployee>', { version: '1.2' }) });
  assert.equal(faultInfo(vm.fault).code, 'soap:VersionMismatch');

  const mu = await call('GetEmployee', '<e:id>1</e:id>', { header: `<x:Tx xmlns:x="urn:tx" xmlns:s="${NS.soap11}" s:mustUnderstand="1">1</x:Tx>` });
  assert.equal(faultInfo(mu.fault).code, 'soap:MustUnderstand');

  // Wrong Content-Type is a transport-level error: the real status is kept.
  const ct = await call('GetEmployee', '<e:id>1</e:id>', { contentType: 'application/json' });
  assert.equal(ct.res.status, 415);
  assert.equal(faultInfo(ct.fault).detailCode, 'unsupported-media-type');
});

test('SOAPAction checking: lenient, strict, off', async () => {
  const wrong = await call('GetEmployee', '<e:id>1</e:id>', { action: `${EMP_NS}/DeleteEmployee` });
  assert.equal(faultInfo(wrong.fault).detailCode, 'soap-action-mismatch');
  const wrong12 = await call('GetEmployee', '<e:id>1</e:id>', { version: '1.2', action: 'urn:wrong' });
  assert.equal(faultInfo(wrong12.fault).detailCode, 'soap-action-mismatch');
  assert.equal((await call('GetEmployee', '<e:id>1</e:id>', { action: null })).res.status, 200);
  assert.equal((await call('GetEmployee', '<e:id>1</e:id>', { action: '' })).res.status, 200);
  await set('soapActionCheck', 'strict');
  try {
    assert.equal(faultInfo((await call('GetEmployee', '<e:id>1</e:id>', { action: null })).fault).detailCode, 'missing-soap-action');
    assert.equal(faultInfo((await call('GetEmployee', '<e:id>1</e:id>', { version: '1.2', action: null })).fault).detailCode, 'missing-soap-action');
    assert.equal((await call('GetEmployee', '<e:id>1</e:id>')).res.status, 200);
    await set('soapActionCheck', 'off');
    assert.equal((await call('GetEmployee', '<e:id>1</e:id>', { action: 'urn:anything' })).res.status, 200);
  } finally {
    await set('soapActionCheck', 'lenient');
  }
});

test('WS-Security UsernameToken: required, PasswordText, PasswordDigest', async () => {
  const sec = (inner) => `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" xmlns:s="${NS.soap11}" s:mustUnderstand="1"><wsse:UsernameToken>${inner}</wsse:UsernameToken></wsse:Security>`;
  const text = (u, p) => sec(`<wsse:Username>${u}</wsse:Username><wsse:Password>${p}</wsse:Password>`);
  await set('soapWsse', 'required');
  try {
    const none = await call('GetEmployee', '<e:id>1</e:id>');
    assert.equal(faultInfo(none.fault).code, 'wsse:InvalidSecurity');
    assert.equal((await call('GetEmployee', '<e:id>1</e:id>', { header: text('demo', 'demo') })).res.status, 200);
    const bad = await call('GetEmployee', '<e:id>1</e:id>', { header: text('demo', 'nope') });
    assert.equal(faultInfo(bad.fault).code, 'wsse:FailedAuthentication');

    const nonce = crypto.randomBytes(16).toString('base64');
    const created = new Date().toISOString();
    const digest = passwordDigest(nonce, created, 'demo');
    const dg = sec(`<wsse:Username>demo</wsse:Username><wsse:Password Type="${TYPE_DIGEST}">${digest}</wsse:Password><wsse:Nonce>${nonce}</wsse:Nonce><wsu:Created>${created}</wsu:Created>`);
    assert.equal((await call('GetEmployee', '<e:id>1</e:id>', { header: dg })).res.status, 200);
    const stale = new Date(Date.now() - 3600e3).toISOString();
    const old = sec(`<wsse:Username>demo</wsse:Username><wsse:Password Type="${TYPE_DIGEST}">${passwordDigest(nonce, stale, 'demo')}</wsse:Password><wsse:Nonce>${nonce}</wsse:Nonce><wsu:Created>${stale}</wsu:Created>`);
    assert.equal(faultInfo((await call('GetEmployee', '<e:id>1</e:id>', { header: old })).fault).code, 'wsse:FailedAuthentication');
  } finally {
    await set('soapWsse', 'off');
  }
  // off: a Security header marked mustUnderstand is not understood
  const mu = await call('GetEmployee', '<e:id>1</e:id>', { header: text('demo', 'demo') });
  assert.equal(faultInfo(mu.fault).code, 'soap:MustUnderstand');
});

test('AUTH_MODE, chaos and rate limit come from the shared stack, as SOAP faults', async () => {
  await set('authMode', 'basic');
  try {
    const u = await call('GetEmployee', '<e:id>1</e:id>');
    assert.equal(u.res.status, 401); // transport level: real status and challenge kept
    assert.match(u.res.get('WWW-Authenticate'), /^Basic /);
    assert.equal(faultInfo(u.fault).code, 'soap:Client');
    assert.equal((await call('GetEmployee', '<e:id>1</e:id>', { headers: { Authorization: `Basic ${Buffer.from('demo:demo').toString('base64')}` } })).res.status, 200);
  } finally {
    await set('authMode', 'none');
  }
  // The WSDL stays open whatever the auth mode.
  await set('authMode', 'bearer');
  try { await request(t.app).get('/soap/EmployeeService?wsdl').expect(200); } finally { await set('authMode', 'none'); }

  const c = await call('GetEmployee', '<e:id>1</e:id>', { headers: { 'X-Force-Error': '503' } });
  assert.equal(c.res.status, 503);
  assert.equal(c.res.get('X-Chaos-Injected'), '503');
  assert.equal(faultInfo(c.fault).code, 'soap:Server');

  const c12 = await call('GetEmployee', '<e:id>1</e:id>', { version: '1.2', headers: { 'X-Force-Error': '429' } });
  assert.equal(c12.res.status, 429);
  assert.equal(c12.res.get('Retry-After'), '5');
  assert.equal(faultInfo(c12.fault).code, 'soap:Sender');
});

test('HMAC signs the raw XML body', async () => {
  await set('authMode', 'hmac');
  try {
    const xml = env('<e:GetEmployee><e:id>1</e:id></e:GetEmployee>');
    const ts = String(Math.floor(Date.now() / 1000));
    const canonical = ['POST', '/soap/EmployeeService', ts, crypto.createHash('sha256').update(xml).digest('hex')].join('\n');
    const sig = crypto.createHmac('sha256', 'demo-hmac').update(canonical).digest('base64');
    const ok = await call('GetEmployee', '', { raw: xml, headers: { Authorization: `HMAC demo:${sig}`, 'X-Timestamp': ts } });
    assert.equal(ok.res.status, 200, ok.res.body);
  } finally {
    await set('authMode', 'none');
  }
});

test('SOAP_ENABLED=false turns the endpoints off', async () => {
  await set('soapEnabled', false);
  try {
    const r = await request(t.app).get('/soap/EmployeeService?wsdl').buffer(true).parse(asText).expect(404);
    assert.match(r.body, /soap-disabled/);
  } finally {
    await set('soapEnabled', true);
  }
});
