'use strict';
// WSDL / SOAP contract tester: load, lint, sample envelopes, try-it validation, run-all with negative
// tests (against this tool's own /soap services), WS-Security, rpc/literal, and schema violations.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { listen } = require('./helpers');
const { parseXml, child, elements, NS } = require('../src/util/xml');
const { Validator, Sampler, addSchema } = require('../src/services/tester/adapters/wsdl/xsd');

let t;
before(async () => { t = await listen({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.stop(); });

const api = () => request(t.app);
const set = (k, v) => t.ctx.settings.set(k, v);

async function loadSelf(name = 'self soap') {
  const r = await api().post('/admin/api/tester/specs').send({ sample: 'self-soap', name }).expect(201);
  assert.equal(r.body.kind, 'wsdl');
  return r.body.id;
}

const failures = (run) => run.steps.filter((s) => s.outcome === 'fail').map((s) => `${s.kind}:${s.test || ''} ${s.opId} ${JSON.stringify(s.checks.filter((c) => c.status === 'fail'))}`);

test('the live SOAP WSDL loads as a WSDL contract with operations, target and clean lint', async () => {
  const samples = (await api().get('/admin/api/tester/samples').expect(200)).body;
  assert.ok(samples.some((s) => s.id === 'self-soap' && s.kind === 'wsdl'));
  const id = await loadSelf();
  const spec = (await api().get(`/admin/api/tester/specs/${id}`).expect(200)).body;
  assert.equal(spec.kind, 'wsdl');
  assert.equal(spec.raw, undefined);
  assert.equal(spec.target.baseUrl, `${t.url}/soap/EmployeeService`);
  assert.deepEqual(spec.operations.map((o) => o.operationId).sort(), ['CreateEmployee', 'DeleteEmployee', 'GetDepartment', 'GetEmployee', 'ListDepartments', 'ListEmployees', 'UpdateEmployee']);
  assert.deepEqual(spec.operations[0].soap.versions, ['1.1', '1.2']);
  assert.equal(spec.lint.error, 0);
  assert.ok(spec.profiles.some((p) => p.type === 'wsse'));

  const doc = await api().get(`/admin/api/tester/specs/${id}/document`).expect(200);
  assert.match(doc.get('Content-Type'), /text\/xml/);
  assert.match(doc.text, /<wsdl:definitions/);

  const list = (await api().get('/admin/api/tester/specs').expect(200)).body;
  assert.equal(list.find((s) => s.id === id).kind, 'wsdl');
  assert.equal(list.find((s) => s.id === id).operations, 7);
});

test('sample requests: SOAP 1.1 SOAPAction header, SOAP 1.2 action in the Content-Type', async () => {
  const id = await loadSelf();
  const r11 = (await api().get(`/admin/api/tester/specs/${id}/request`).query({ op: 'EmployeeService/GetEmployee' }).expect(200)).body;
  assert.equal(r11.soapVersion, '1.1');
  assert.match(r11.contentType, /^text\/xml/);
  assert.equal(r11.params.find((p) => p.name === 'SOAPAction').value, '"urn:api-test-tool:soap:EmployeeService/GetEmployee"');
  const env = parseXml(r11.body);
  assert.equal(env.ns, NS.soap11);
  assert.equal(elements(child(env, 'Body', NS.soap11))[0].local, 'GetEmployee');

  const r12 = (await api().get(`/admin/api/tester/specs/${id}/request`).query({ op: 'EmployeeService/GetEmployee', version: '1.2' }).expect(200)).body;
  assert.equal(r12.soapVersion, '1.2');
  assert.match(r12.contentType, /^application\/soap\+xml; charset=utf-8; action="urn:api-test-tool:soap:EmployeeService\/GetEmployee"$/);
  assert.ok(!r12.params.some((p) => p.name === 'SOAPAction'));
  assert.equal(parseXml(r12.body).ns, NS.soap12);
});

test('try it: a valid response passes; a fault is reported', async () => {
  const id = await loadSelf();
  const ok = (await api().post(`/admin/api/tester/specs/${id}/send`).send({ opId: 'EmployeeService/GetEmployee' }).expect(200)).body;
  assert.equal(ok.outcome, 'pass', JSON.stringify(ok.checks));
  assert.ok(ok.checks.some((c) => c.name === 'body-schema' && c.status === 'pass'));

  const req = (await api().get(`/admin/api/tester/specs/${id}/request`).query({ op: 'EmployeeService/GetEmployee' })).body;
  req.body = req.body.replace(/<ns1:id>1<\/ns1:id>/, '<ns1:id>999999</ns1:id>');
  const nf = (await api().post(`/admin/api/tester/specs/${id}/send`).send({ opId: 'EmployeeService/GetEmployee', request: req }).expect(200)).body;
  assert.equal(nf.outcome, 'fail');
  assert.ok(nf.checks.some((c) => c.name === 'no-fault' && /soap:Client/.test(c.message)), JSON.stringify(nf.checks));
  assert.ok(nf.checks.some((c) => c.name === 'fault-http-status' && c.status === 'pass'));
});

test('run all against this tool, SOAP 1.1 and 1.2, with negative tests', async () => {
  const id = await loadSelf();
  const run = (await api().post(`/admin/api/tester/specs/${id}/runs`).send({ negative: true }).expect(201)).body;
  assert.equal(run.kind, 'wsdl');
  assert.deepEqual(failures(run), []);
  const tests = new Set(run.steps.filter((s) => s.kind === 'negative').map((s) => s.test));
  for (const k of ['missing-element', 'unknown-id', 'malformed-xml']) assert.ok(tests.has(k), k);
  // id chaining: the employee created first is read, updated and deleted
  const created = run.steps.find((s) => s.operationId === 'CreateEmployee' && s.kind === 'positive');
  const newId = /<tns:employee><tns:id>(\d+)<\/tns:id>/.exec(created.response.body)[1];
  const del = run.steps.find((s) => s.operationId === 'DeleteEmployee' && s.kind === 'positive');
  assert.match(del.request.body, new RegExp(`<ns1:id>${newId}</ns1:id>`));
  assert.equal(run.variables['employee.id'], newId);

  await api().put(`/admin/api/tester/specs/${id}`).send({ target: { soapVersion: '1.2' } }).expect(200);
  const run12 = (await api().post(`/admin/api/tester/specs/${id}/runs`).send({ negative: true }).expect(201)).body;
  assert.deepEqual(failures(run12), []);
  assert.match(run12.steps[0].request.headers['Content-Type'], /application\/soap\+xml/);

  const html = await api().get(`/admin/api/tester/runs/${run.id}/report.html`).expect(200);
  assert.match(html.text, /EmployeeService\/CreateEmployee/);
});

test('WS-Security and HTTP auth profiles, including the no-credentials negative test', async () => {
  const id = await loadSelf();
  await set('soapWsse', 'required');
  try {
    const none = (await api().post(`/admin/api/tester/specs/${id}/send`).send({ opId: 'EmployeeService/GetEmployee' }).expect(200)).body;
    assert.equal(none.outcome, 'fail');
    for (const passwordType of ['text', 'digest']) {
      await api().put(`/admin/api/tester/specs/${id}`).send({ target: { auth: { type: 'wsse', username: 'demo', password: 'demo', passwordType } } }).expect(200);
      const r = (await api().post(`/admin/api/tester/specs/${id}/send`).send({ opId: 'EmployeeService/GetEmployee' }).expect(200)).body;
      assert.equal(r.outcome, 'pass', `${passwordType}: ${JSON.stringify(r.checks)}`);
      assert.match(r.request.body, /wsse:UsernameToken/);
    }
    const run = (await api().post(`/admin/api/tester/specs/${id}/runs`).send({ negative: true, operationIds: ['EmployeeService/GetEmployee'] }).expect(201)).body;
    const noAuth = run.steps.find((s) => s.test === 'no-auth');
    assert.ok(noAuth && noAuth.outcome !== 'fail', JSON.stringify(noAuth?.checks));
  } finally {
    await set('soapWsse', 'off');
  }

  await set('authMode', 'basic');
  try {
    await api().put(`/admin/api/tester/specs/${id}`).send({ target: { auth: { type: 'basic', username: 'demo', password: 'demo' } } }).expect(200);
    const run = (await api().post(`/admin/api/tester/specs/${id}/runs`).send({ negative: true, operationIds: ['EmployeeService/ListDepartments'] }).expect(201)).body;
    assert.deepEqual(failures(run), []);
    const noAuth = run.steps.find((s) => s.test === 'no-auth');
    assert.equal(noAuth.outcome, 'pass');
    assert.equal(noAuth.response.status, 401);
  } finally {
    await set('authMode', 'none');
  }
});

// ---------------------------------------------------------------- rpc/literal + lint
const RPC_WSDL = (address) => `<?xml version="1.0"?>
<definitions name="Calc" targetNamespace="urn:calc" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="urn:calc"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <types><xsd:schema targetNamespace="urn:calc">
    <xsd:simpleType name="Small"><xsd:restriction base="xsd:int"><xsd:minInclusive value="0"/><xsd:maxInclusive value="100"/></xsd:restriction></xsd:simpleType>
  </xsd:schema></types>
  <message name="AddRequest"><part name="a" type="tns:Small"/><part name="b" type="tns:Small"/></message>
  <message name="AddResponse"><part name="result" type="xsd:int"/></message>
  <portType name="CalcPort"><operation name="Add"><input message="tns:AddRequest"/><output message="tns:AddResponse"/></operation></portType>
  <binding name="CalcBinding" type="tns:CalcPort">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Add"><soap:operation soapAction="urn:calc#Add"/>
      <input><soap:body use="literal" namespace="urn:calc"/></input><output><soap:body use="literal" namespace="urn:calc"/></output></operation>
  </binding>
  <service name="CalcService"><port name="CalcPort" binding="tns:CalcBinding"><soap:address location="${address}"/></port></service>
</definitions>`;

const rpcResponse = (result) => `<s:Envelope xmlns:s="${NS.soap11}"><s:Body><c:AddResponse xmlns:c="urn:calc"><result>${result}</result></c:AddResponse></s:Body></s:Envelope>`;

test('rpc/literal: wrapper element, unqualified parts, and schema violations in the response', async () => {
  await set('inspectorRules', [
    { method: 'POST', path: '/calc-ok', status: 200, contentType: 'text/xml; charset=utf-8', body: rpcResponse(3) },
    { method: 'POST', path: '/calc-bad', status: 200, contentType: 'text/xml; charset=utf-8', body: rpcResponse('three') },
  ]);
  try {
    const id = (await api().post('/admin/api/tester/specs').send({ name: 'calc', content: RPC_WSDL(`${t.url}/calc-ok`) }).expect(201)).body.id;
    const spec = (await api().get(`/admin/api/tester/specs/${id}`).expect(200)).body;
    assert.equal(spec.kind, 'wsdl');
    assert.equal(spec.operations[0].soap.style, 'rpc');
    const req = (await api().get(`/admin/api/tester/specs/${id}/request`).query({ op: 'CalcService/Add' }).expect(200)).body;
    const op = elements(child(parseXml(req.body), 'Body', NS.soap11))[0];
    assert.equal(op.local, 'Add');
    assert.equal(op.ns, 'urn:calc');
    assert.deepEqual(elements(op).map((e) => [e.local, e.ns]), [['a', ''], ['b', '']]);

    const ok = (await api().post(`/admin/api/tester/specs/${id}/send`).send({ opId: 'CalcService/Add' }).expect(200)).body;
    assert.equal(ok.outcome, 'pass', JSON.stringify(ok.checks));

    const bad = (await api().post(`/admin/api/tester/specs/${id}/send`).send({ opId: 'CalcService/Add', target: { baseUrl: `${t.url}/calc-bad` } }).expect(200)).body;
    const schema = bad.checks.find((c) => c.name === 'body-schema');
    assert.equal(schema.status, 'fail');
    assert.match(schema.errors[0].message, /xsd:int/);
    assert.equal(schema.errors[0].pointer, '/AddResponse/result');
  } finally {
    await set('inspectorRules', []);
  }
});

test('WSDL lint flags broken references, encoded messages and placeholder addresses', async () => {
  const broken = RPC_WSDL('http://localhost:9/calc')
    .replace('type="tns:Small"/><part name="b"', 'type="tns:Missing"/><part name="b"')
    .replace('<soap:body use="literal" namespace="urn:calc"/></input>', '<soap:body use="encoded" namespace="urn:calc"/></input>');
  const r = await api().post('/admin/api/tester/specs').send({ name: 'broken', content: broken }).expect(201);
  const lint = (await api().get(`/admin/api/tester/specs/${r.body.id}/lint`).expect(200)).body;
  const rules = lint.issues.map((i) => i.rule);
  for (const rule of ['unknown-type', 'soap-encoding', 'placeholder-address']) assert.ok(rules.includes(rule), `${rule} in ${rules.join(',')}`);

  await api().post('/admin/api/tester/specs').send({ content: '<definitions xmlns="http://www.w3.org/ns/wsdl"/>' }).expect(422);
  await api().post('/admin/api/tester/specs').send({ content: '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"><oops></definitions>' }).expect(422);
});

// ---------------------------------------------------------------- XSD engine
const SCHEMA = `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" xmlns:t="urn:t" elementFormDefault="qualified">
  <xsd:complexType name="Base"><xsd:sequence><xsd:element name="id" type="xsd:long"/></xsd:sequence></xsd:complexType>
  <xsd:complexType name="Order"><xsd:complexContent><xsd:extension base="t:Base"><xsd:sequence>
    <xsd:element name="status"><xsd:simpleType><xsd:restriction base="xsd:string"><xsd:enumeration value="OPEN"/><xsd:enumeration value="CLOSED"/></xsd:restriction></xsd:simpleType></xsd:element>
    <xsd:choice><xsd:element name="email" type="xsd:string"/><xsd:element name="phone" type="xsd:string"/></xsd:choice>
    <xsd:element name="line" maxOccurs="unbounded"><xsd:complexType><xsd:sequence>
      <xsd:element name="sku"><xsd:simpleType><xsd:restriction base="xsd:string"><xsd:pattern value="[A-Z]{3}-[0-9]{2}"/></xsd:restriction></xsd:simpleType></xsd:element>
      <xsd:element name="qty"><xsd:simpleType><xsd:restriction base="xsd:decimal"><xsd:fractionDigits value="2"/><xsd:minExclusive value="0"/></xsd:restriction></xsd:simpleType></xsd:element>
    </xsd:sequence><xsd:attribute name="no" type="xsd:int" use="required"/></xsd:complexType></xsd:element>
    <xsd:element name="note" type="xsd:string" minOccurs="0" nillable="true"/>
  </xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType>
  <xsd:element name="order" type="t:Order"/>
</xsd:schema>`;

test('XSD engine: extension, choice, enumerations, patterns, facets, attributes, nillable', () => {
  const model = {};
  addSchema(model, parseXml(SCHEMA));
  const decl = model['urn:t'].elements.order;
  const v = new Validator(model);
  const check = (xml) => { const errors = []; v.element(parseXml(xml), decl, '/order', errors); return errors; };
  const ns = 'xmlns="urn:t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

  assert.deepEqual(check(`<order ${ns}><id>9007199254740993</id><status>OPEN</status><phone>1</phone><line no="1"><sku>ABC-12</sku><qty>1.50</qty></line><line no="2"><sku>XYZ-99</sku><qty>2</qty></line><note xsi:nil="true"/></order>`), []);

  const errs = check(`<order ${ns}><id>x</id><status>NEW</status><line><sku>abc</sku><qty>1.555</qty></line><extra/></order>`).map((e) => `${e.pointer} ${e.message}`);
  const has = (re) => assert.ok(errs.some((e) => re.test(e)), `${re} in\n${errs.join('\n')}`);
  has(/\/order\/id .*xsd:long/);
  has(/\/order\/status .*one of: OPEN, CLOSED/);
  has(/\/order\/email\|phone required element is missing/);
  has(/\/line\[1\]\/@no required attribute/);
  has(/\/line\[1\]\/sku .*pattern/);
  has(/\/line\[1\]\/qty .*fraction digits/);
  has(/\/order\/extra unexpected element/);

  // The sampler produces an instance that validates.
  const s = new Sampler(model);
  const xml = s.element(decl);
  const sample = parseXml(xml.replace(/^<(\w+:)?order/, (m) => `${m}${s.declarations()}`));
  const errors = [];
  v.element(sample, decl, '/order', errors);
  assert.deepEqual(errors, [], xml);
});
