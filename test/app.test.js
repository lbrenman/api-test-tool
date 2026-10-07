'use strict';
// Back-office app (/app) and its backend (/admin/api/app/*).
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { makeApp } = require('./helpers');

const A = '/admin/api/app';

test('app pages are served and need no /v1 credentials', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', AUTH_MODE: 'bearer' });
  try {
    await request(t.app).get('/app').expect(301);
    const page = await request(t.app).get('/app/').expect(200);
    assert.match(page.text, /Acme Back Office/);
    await request(t.app).get('/app/app.js').expect(200).expect('Content-Type', /javascript/);
    await request(t.app).get('/app/app.css').expect(200).expect('Content-Type', /css/);
    const missing = await request(t.app).get('/app/nope.js').expect(404);
    assert.match(missing.headers['content-type'], /problem\+json/);
    // /app is reserved: not captured by the inspector
    assert.ok(!(await t.ctx.inspector.list()).some((x) => x.path.startsWith('/app')));
    // the app backend ignores the /v1 auth mode
    await request(t.app).get(`${A}/summary`).expect(200);
    await request(t.app).get('/v1/employees').expect(401);
  } finally { await t.close(); }
});

test('summary KPIs agree with the data', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  try {
    const s = (await request(t.app).get(`${A}/summary`).expect(200)).body;
    const counts = await t.ctx.resources.counts();
    assert.equal(s.people.headcount, counts.employees);
    assert.equal(s.people.departments, counts.departments);
    assert.equal(s.catalog.products, counts.products);
    const emps = await t.ctx.resources.all('employees');
    assert.equal(s.people.active, emps.filter((e) => e.isActive).length);
    assert.equal(s.charts.headcountByDepartment.reduce((a, x) => a + x.value, 0), counts.employees);
    assert.equal(s.charts.productsByCategory.reduce((a, x) => a + x.value, 0), counts.products);
    assert.equal(s.charts.stockStatus.reduce((a, x) => a + x.value, 0), counts.products);
    assert.equal(s.charts.hiresByYear.reduce((a, x) => a + x.value, 0), counts.employees);
    assert.ok(s.recent.length > 0 && s.recent.length <= 8);
    const lk = (await request(t.app).get(`${A}/lookups`).expect(200)).body;
    assert.equal(lk.departments.length, counts.departments);
    assert.equal(lk.employees.length, counts.employees);
  } finally { await t.close(); }
});

test('list: search, filters, sort and paging with computed columns', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  try {
    const all = (await request(t.app).get(`${A}/records/employees?size=100`).expect(200)).body;
    assert.equal(all.total, 40);
    assert.equal(all.items[0].fullName, `${all.items[0].firstName} ${all.items[0].lastName}`);
    const page2 = (await request(t.app).get(`${A}/records/employees?size=15&page=2&sort=-salary`).expect(200)).body;
    assert.equal(page2.items.length, 15);
    assert.equal(page2.pages, 3);
    for (let i = 1; i < page2.items.length; i += 1) assert.ok(page2.items[i - 1].salary >= page2.items[i].salary);
    const dep = all.items[0].departmentId;
    const inDep = (await request(t.app).get(`${A}/records/employees?departmentId=${dep}&size=100`).expect(200)).body;
    assert.ok(inDep.items.every((e) => e.departmentId === dep));
    const q = (await request(t.app).get(`${A}/records/employees?q=${encodeURIComponent(all.items[3].email)}`).expect(200)).body;
    assert.ok(q.items.some((e) => e.id === all.items[3].id));
    const low = (await request(t.app).get(`${A}/records/products?stockStatus=low&size=100`).expect(200)).body;
    assert.ok(low.items.every((p) => p.stockStatus === 'low'));
    const deps = (await request(t.app).get(`${A}/records/departments?size=100`).expect(200)).body;
    assert.equal(deps.items.reduce((a, d) => a + d.employeeCount, 0), 40);
    const cats = (await request(t.app).get(`${A}/records/categories`).expect(200)).body;
    assert.ok(cats.items.every((c) => typeof c.inventoryValueUsd === 'number'));
    await request(t.app).get(`${A}/records/widgets`).expect(404);
    await request(t.app).get(`${A}/records/employees?nope=1`).expect(400);
  } finally { await t.close(); }
});

test('create, update, read with related records, and delete', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', DATE_FORMAT: 'epoch-ms' });
  try {
    const dept = (await request(t.app).post(`${A}/records/departments`).send({ name: 'Field Ops', code: 'FOPS' }).expect(201)).body;
    assert.equal(dept.employeeCount, 0);
    assert.match(dept.createdAt, /^\d{4}-\d{2}-\d{2}T/, 'app timestamps are ISO even when /v1 uses epoch');

    const bad = await request(t.app).post(`${A}/records/employees`).send({ firstName: 'Ada', lastName: 'L', email: 'not-an-email', departmentId: dept.id }).expect(422);
    assert.ok(bad.body.errors.some((e) => e.field === 'email'));

    const emp = (await request(t.app).post(`${A}/records/employees`).send({
      firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', departmentId: dept.id, salary: 120000, skills: ['math'], address: { city: 'London', countryCode: 'GB' },
    }).expect(201)).body;
    assert.equal(emp.fullName, 'Ada Lovelace');
    assert.equal(emp.department.name, 'Field Ops');

    const upd = (await request(t.app).patch(`${A}/records/employees/${emp.id}`).send({ title: 'Analyst', address: { city: null, region: 'Greater London' } }).expect(200)).body;
    assert.equal(upd.title, 'Analyst');
    assert.equal(upd.address.region, 'Greater London');
    assert.equal(upd.address.countryCode, 'GB');
    assert.equal(upd.address.city, undefined);
    assert.equal((await request(t.app).get(`/v1/employees/${emp.id}`).expect(200)).body.title, 'Analyst', 'same data as /v1');

    const report = (await request(t.app).post(`${A}/records/employees`).send({ firstName: 'Bo', lastName: 'B', email: 'bo@example.com', departmentId: dept.id, managerId: emp.id }).expect(201)).body;
    assert.equal(report.managerName, 'Ada Lovelace');
    const rec = (await request(t.app).get(`${A}/records/employees/${emp.id}`).expect(200)).body;
    assert.deepEqual(rec.related.directReports.map((r) => r.id), [report.id]);
    const d = (await request(t.app).get(`${A}/records/departments/${dept.id}`).expect(200)).body;
    assert.equal(d.record.employeeCount, 2);
    assert.equal(d.related.employees.length, 2);

    const inUse = await request(t.app).delete(`${A}/records/departments/${dept.id}`).expect(409);
    assert.match(inUse.body.detail, /still has employees/);
    await request(t.app).delete(`${A}/records/employees/${emp.id}`).expect(204);
    await request(t.app).delete(`${A}/records/employees/${report.id}`).expect(204);
    await request(t.app).delete(`${A}/records/departments/${dept.id}`).expect(204);
    await request(t.app).get(`${A}/records/departments/${dept.id}`).expect(404);
    await request(t.app).patch(`${A}/records/departments/${dept.id}`).send({ name: 'X' }).expect(404);
  } finally { await t.close(); }
});

test('the app backend is not affected by chaos, rate limits or required headers', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', ERROR_RATE: '100', ERROR_TYPES: '500', RATE_LIMIT_RPM: '1', REQUIRED_HEADERS: 'X-Tenant' });
  try {
    for (let i = 0; i < 3; i += 1) await request(t.app).get(`${A}/records/products`).expect(200);
    await request(t.app).get('/v1/products').set('X-Tenant', 'a').expect((r) => assert.ok(r.status >= 400));
  } finally { await t.close(); }
});

test('the app backend needs the dashboard password when one is set', async () => {
  const t = await makeApp({ SEED_SAMPLE_FILES: 'false', ADMIN_PASSWORD: 's3cret' });
  try {
    await request(t.app).get(`${A}/summary`).expect(401);
    await request(t.app).post(`${A}/records/departments`).send({ name: 'X', code: 'XX' }).expect(401);
    await request(t.app).get(`${A}/summary`).auth('admin', 's3cret').expect(200);
    await request(t.app).get('/app/').expect(200); // the page itself loads and shows a sign-in form
  } finally { await t.close(); }
});
