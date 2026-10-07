'use strict';
// OData v4: service document, $metadata, query options ($filter, $select, $expand, $orderby, $top,
// $skip, $count, $search), server-driven paging, key/property/navigation addressing, CRUD with
// @odata.bind, Prefer and If-Match, metadata levels, the OData error format, the shared stack and settings.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { listen } = require('./helpers');
const { compileFilter } = require('../src/protocols/odata/expr');

let t;
before(async () => { t = await listen({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.stop(); });

const api = () => request(t.app);
const set = (k, v) => t.ctx.settings.set(k, v);
const q = (path, params) => `${path}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

test('service document, $metadata and response headers', async () => {
  const sd = await api().get('/odata/v4').expect(200);
  assert.equal(sd.get('OData-Version'), '4.0');
  assert.match(sd.get('Content-Type'), /^application\/json;odata\.metadata=minimal/);
  assert.deepEqual(sd.body.value.map((x) => x.name), ['Employees', 'Products', 'Departments', 'Categories']);
  const md = await api().get('/odata/v4/$metadata').expect(200);
  assert.match(md.get('Content-Type'), /application\/xml/);
  assert.match(md.text, /<EntityType Name="Employee">/);
  assert.match(md.text, /<NavigationProperty Name="department" Type="ApiTestTool\.Department" Nullable="false" Partner="employees"><ReferentialConstraint Property="departmentId"/);
  assert.match(md.text, /<EntitySet Name="Employees" EntityType="ApiTestTool\.Employee">/);
  assert.equal((await api().get('/odata').expect(200)).body.versions.v4.serviceRoot.endsWith('/odata/v4'), true);
});

test('$filter, $orderby, $select, $top, $skip, $count, $search', async () => {
  const all = (await api().get(q('/odata/v4/Employees', { $top: '1000', $select: 'id,level,salary,lastName,skills' })).expect(200)).body.value;
  const r = (await api().get(q('/odata/v4/Employees', { $filter: "level eq 'L3' and salary gt 1", $orderby: 'salary desc', $count: 'true', $select: 'level,salary' })).expect(200)).body;
  const expected = all.filter((e) => e.level === 'L3' && e.salary > 1);
  assert.equal(r['@odata.count'], expected.length);
  assert.ok(r['@odata.context'].endsWith('$metadata#Employees(level,salary)'));
  assert.deepEqual(r.value.map((e) => e.salary), expected.map((e) => e.salary).sort((a, b) => b - a));
  assert.deepEqual(Object.keys(r.value[0]).sort(), ['@odata.etag', 'id', 'level', 'salary']);

  const fn = (await api().get(q('/odata/v4/Employees', { $filter: "startswith(tolower(lastName), 'a') or level in ('L6','L7')", $select: 'lastName,level' })).expect(200)).body.value;
  assert.ok(fn.length && fn.every((e) => e.lastName.toLowerCase().startsWith('a') || ['L6', 'L7'].includes(e.level)));
  const withSkill = all.find((e) => e.skills.length);
  const lambda = (await api().get(q('/odata/v4/Employees', { $filter: `skills/any(s: s eq '${withSkill.skills[0].replace(/'/g, "''")}')`, $select: 'id,skills' })).expect(200)).body.value;
  assert.ok(lambda.some((e) => e.id === withSkill.id) && lambda.every((e) => e.skills.includes(withSkill.skills[0])));
  const nav = (await api().get(q('/odata/v4/Employees', { $filter: 'department/id eq 1', $select: 'departmentId' })).expect(200)).body.value;
  assert.ok(nav.length && nav.every((e) => e.departmentId === 1));

  const page = (await api().get(q('/odata/v4/Products', { $orderby: 'id', $skip: '2', $top: '3', $select: 'id' })).expect(200)).body.value;
  assert.deepEqual(page.map((p) => p.id), [3, 4, 5]);
  assert.equal((await api().get(q('/odata/v4/Employees/$count', { $filter: "level eq 'L3'" })).expect(200)).text, String(all.filter((e) => e.level === 'L3').length));
  const s = (await api().get(q('/odata/v4/Employees', { $search: all[0].lastName, $select: 'lastName' })).expect(200)).body.value;
  assert.ok(s.some((e) => e.lastName === all[0].lastName));

  for (const bad of [{ $filter: 'nope eq 1' }, { $filter: "level eq 'L3" }, { $filter: 'salary eq' }, { $select: 'nope' }, { $top: '-1' }, { $orderby: 'nope' }, { $expand: 'nope' }, { $foo: '1' }]) {
    const e = await api().get(q('/odata/v4/Employees', bad)).expect(400);
    assert.ok(e.body.error.message, JSON.stringify(bad));
  }
  await api().get(q('/odata/v4/Employees', { $apply: 'groupby((level))' })).expect(501);
});

test('expression semantics: literals, null, dates, arithmetic', () => {
  const doc = { name: "O'Brien", salary: 100, rating: null, hireDate: '2021-03-04', createdAt: '2024-01-01T10:00:00.000Z', address: { city: 'Ottawa' }, skills: ['Go'] };
  const ok = (f, want = true) => assert.equal(compileFilter(f, 'Employee')({ ...doc, lastName: doc.name, performanceRating: null }, { parent: () => null, children: () => [] }), want, f);
  ok("lastName eq 'O''Brien'");
  ok('performanceRating eq null');
  ok('performanceRating gt 1', false);
  ok('hireDate ge 2021-01-01 and year(hireDate) eq 2021 and month(hireDate) eq 3');
  ok('createdAt lt 2024-01-01T11:00:00+00:00');
  ok('salary mul 2 sub 50 eq 150 and salary mod 7 eq 2 and -salary lt 0');
  ok("address/city eq 'Ottawa' and length(skills) eq 1 and skills/all(s: length(s) eq 2)");
  ok("not contains(lastName, 'x') and concat(lastName, '!') eq 'O''Brien!'");
});

test('$expand with nested options, navigation paths, properties and paging', async () => {
  const d = (await api().get(q('/odata/v4/Departments(1)', { $expand: 'employees($select=firstName;$orderby=id desc;$top=2;$count=true)' })).expect(200));
  assert.ok(d.get('ETag').startsWith('W/"'));
  assert.ok(d.body['@odata.context'].endsWith('#Departments(employees(firstName))/$entity'));
  assert.equal(d.body.employees.length, Math.min(2, d.body['employees@odata.count']));
  assert.ok(d.body.employees[0].id > (d.body.employees[1]?.id ?? 0));
  const e = (await api().get(q('/odata/v4/Employees(1)', { $select: 'firstName,address/city', $expand: 'department($select=name),manager,directReports($select=id)' })).expect(200)).body;
  assert.deepEqual(Object.keys(e).filter((k) => !k.startsWith('@')).sort(), ['address', 'department', 'directReports', 'firstName', 'id', 'manager'].sort());
  assert.ok(e.department.name);
  await api().get(q('/odata/v4/Employees(1)', { $expand: 'department($top=1)' })).expect(400);

  const nav = (await api().get('/odata/v4/Employees(1)/department').expect(200)).body;
  assert.ok(nav['@odata.context'].endsWith('#Departments/$entity'));
  const kids = (await api().get(q('/odata/v4/Departments(1)/employees', { $select: 'departmentId', $count: 'true' })).expect(200)).body;
  assert.ok(kids.value.every((x) => x.departmentId === 1));
  assert.equal((await api().get('/odata/v4/Departments(1)/employees/$count').expect(200)).text, String(kids['@odata.count']));
  assert.equal((await api().get('/odata/v4/Employees(1)/address').expect(200)).body['@odata.context'].endsWith('#Employees(1)/address'), true);
  assert.equal(typeof (await api().get('/odata/v4/Employees(id=1)/salary').expect(200)).body.value, 'number');
  assert.equal((await api().get('/odata/v4/Employees(1)/email/$value').expect(200)).get('Content-Type').startsWith('text/plain'), true);
  await api().get('/odata/v4/Employees(abc)').expect(400);
  await api().get('/odata/v4/Employees(999999)').expect(404);
  await api().get('/odata/v4/Employees(1)/nope').expect(404);

  // Server-driven paging: follow @odata.nextLink to the end, see every product once.
  await set('odataMaxPageSize', 7);
  try {
    const total = Number((await api().get('/odata/v4/Products/$count').expect(200)).text);
    const seen = [];
    let url = '/odata/v4/Products?$select=id&$count=true';
    let pages = 0;
    while (url) {
      const b = (await api().get(url).expect(200)).body;
      if (pages === 0) assert.equal(b['@odata.count'], total);
      seen.push(...b.value.map((p) => p.id));
      assert.ok(b.value.length <= 7);
      url = b['@odata.nextLink'] ? new URL(b['@odata.nextLink']).pathname + new URL(b['@odata.nextLink']).search : null;
      pages += 1;
    }
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total);
    const pref = await api().get('/odata/v4/Products?$select=id&$top=5').set('Prefer', 'odata.maxpagesize=2').expect(200);
    assert.equal(pref.get('Preference-Applied'), 'odata.maxpagesize=2');
    assert.equal(pref.body.value.length, 2);
    const last = new URL(pref.body['@odata.nextLink']);
    const p2 = (await api().get(last.pathname + last.search).set('Prefer', 'odata.maxpagesize=2').expect(200)).body;
    const p3u = new URL(p2['@odata.nextLink']);
    const p3 = (await api().get(p3u.pathname + p3u.search).set('Prefer', 'odata.maxpagesize=2').expect(200)).body;
    assert.equal(p3.value.length, 1); // $top=5 is honoured across pages
    assert.equal(p3['@odata.nextLink'], undefined);
  } finally { await set('odataMaxPageSize', 100); }
});

test('metadata levels and formats', async () => {
  const full = (await api().get('/odata/v4/Categories(1)').set('Accept', 'application/json;odata.metadata=full').expect(200));
  assert.match(full.get('Content-Type'), /odata\.metadata=full/);
  assert.equal(full.body['@odata.type'], '#ApiTestTool.Category');
  assert.equal(full.body['@odata.editLink'], 'Categories(1)');
  assert.equal(full.body['products@odata.navigationLink'], 'Categories(1)/products');
  const none = (await api().get('/odata/v4/Categories?$format=application/json;odata.metadata=none&$top=1').expect(200)).body;
  assert.equal(none['@odata.context'], undefined);
  assert.equal(none.value[0]['@odata.etag'], undefined);
  await api().get('/odata/v4/Categories').set('Accept', 'application/xml').expect(406);
  await api().get('/odata/v4/Categories?$format=xml').expect(406);
});

test('CRUD: create with @odata.bind, Prefer, If-Match, merge PATCH, PUT, DELETE, errors', async () => {
  const dep = await api().post('/odata/v4/Departments').send({ '@odata.type': '#ApiTestTool.Department', name: 'OData Dept', code: 'OD-T1' }).expect(201);
  assert.ok(dep.get('Location').endsWith(`/odata/v4/Departments(${dep.body.id})`));
  const depId = dep.body.id;
  const emp = (await api().post('/odata/v4/Employees').send({ firstName: 'O', lastName: 'Data', email: 'o.data@example.com', 'department@odata.bind': `Departments(${depId})`, address: { city: 'Boston' } }).expect(201)).body;
  assert.equal(emp.departmentId, depId);
  assert.equal((await api().get(`/v1/employees/${emp.id}`).expect(200)).body.department.code, 'OD-T1');

  const min = await api().post('/odata/v4/Categories').set('Prefer', 'return=minimal').send({ name: 'OData Cat', code: 'OD-C1' }).expect(204);
  assert.equal(min.get('Preference-Applied'), 'return=minimal');
  const catId = Number(/\((\d+)\)$/.exec(min.get('OData-EntityId'))[1]);

  const got = await api().get(`/odata/v4/Employees(${emp.id})`).expect(200);
  await api().patch(`/odata/v4/Employees(${emp.id})`).set('If-Match', 'W/"stale"').send({ title: 'x' }).expect(412);
  const patched = await api().patch(`/odata/v4/Employees(${emp.id})`).set('If-Match', got.get('ETag')).send({ title: 'Analyst', address: { region: 'MA' } }).expect(204);
  assert.ok(patched.get('ETag'));
  const rep = (await api().patch(`/odata/v4/Employees(${emp.id})`).set('Prefer', 'return=representation').send({ level: 'L2' }).expect(200)).body;
  assert.equal(rep.title, 'Analyst');
  assert.deepEqual(rep.address, { city: 'Boston', region: 'MA' });
  await api().put(`/odata/v4/Departments(${depId})`).send({ name: 'Replaced', code: 'OD-T2' }).expect(204);
  assert.equal((await api().get(`/odata/v4/Departments(${depId})/code/$value`).expect(200)).text, 'OD-T2');

  const unknown = await api().post('/odata/v4/Departments').send({ name: 'x', code: 'OD-X', colour: 'red' }).expect(400);
  assert.equal(unknown.body.error.target, 'colour');
  const invalid = await api().post('/odata/v4/Departments').send({ name: 'x', code: 'lower case' }).expect(422);
  assert.equal(invalid.body.error.code, 'validation-failed');
  assert.ok(invalid.body.error.details.some((x) => x.target === 'code'));
  await api().post('/odata/v4/Employees').send({ firstName: 'a', lastName: 'b', email: 'a.b@example.com', 'department@odata.bind': 'nope' }).expect(400);
  await api().post('/odata/v4/Employees').send({ firstName: 'a', lastName: 'b', email: 'a.b@example.com', department: { name: 'deep' } }).expect(501);
  const conflict = await api().delete(`/odata/v4/Departments(${depId})`).expect(409);
  assert.equal(conflict.body.error.code, 'resource-in-use');
  await api().post(`/odata/v4/Employees(${emp.id})`).send({}).expect(405);
  await api().delete('/odata/v4/Employees').expect(405);

  await api().delete(`/odata/v4/Employees(${emp.id})`).expect(204);
  await api().delete(`/odata/v4/Departments(${depId})`).expect(204);
  await api().delete(`/odata/v4/Categories(${catId})`).expect(204);
  await api().get(`/odata/v4/Categories(${catId})`).expect(404);
});

test('shared stack (auth, chaos), open metadata, settings', async () => {
  await set('authMode', 'bearer');
  try {
    const r = await api().get('/odata/v4/Employees').expect(401);
    assert.ok(r.get('WWW-Authenticate'));
    assert.equal(r.body.error.innererror.status, 401);
    assert.equal(r.get('OData-Version'), '4.0');
    await api().get('/odata/v4/Employees?$top=1').set('Authorization', 'Bearer demo-token').expect(200);
    await api().get('/odata/v4/$metadata').expect(200);
    await api().get('/odata/v4').expect(200);
  } finally { await set('authMode', 'none'); }
  const forced = await api().get('/odata/v4/Employees').set('X-Force-Error', '503').expect(503);
  assert.ok(forced.body.error.message);
  await api().post('/odata/v4/$batch').expect(501);
  await set('odataEnabled', false);
  try { await api().get('/odata/v4').expect(404); } finally { await set('odataEnabled', true); }
});
