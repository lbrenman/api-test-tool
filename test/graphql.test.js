'use strict';
// GraphQL: queries (offset pages, Relay connections, filters, nested resolvers), mutations through the
// shared ResourceService, error shapes (field errors vs request/transport errors, both response media
// types), the shared stack (auth, chaos), GRAPHQL_* settings, and subscriptions over graphql-transport-ws.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { listen } = require('./helpers');
const { connect } = require('../src/util/websocket');

let t;
before(async () => { t = await listen({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.stop(); });

const api = () => request(t.app);
const set = (k, v) => t.ctx.settings.set(k, v);
const gql = (query, variables, headers = {}) => {
  let r = api().post('/graphql');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send({ query, variables });
};

test('SDL, GraphiQL page and query basics (offset page, nested resolvers, GET)', async () => {
  const sdl = await api().get('/graphql/schema.graphql').expect(200);
  assert.match(sdl.text, /type Query \{/);
  assert.match(sdl.text, /type Subscription \{/);
  const page = await api().get('/graphql').set('Accept', 'text/html').expect(200);
  assert.match(page.text, /graphiql/i);

  const r = await gql('query($n: Int) { employees(limit: $n, sort: "id") { total limit offset items { id fullName department { id name employeeCount } manager { id } } } counts { employees departments } }', { n: 3 }).expect(200);
  assert.match(r.get('Content-Type'), /^application\/json/);
  assert.equal(r.body.errors, undefined, JSON.stringify(r.body.errors));
  const { employees, counts } = r.body.data;
  assert.equal(employees.items.length, 3);
  assert.equal(employees.total, counts.employees);
  assert.deepEqual(employees.items.map((e) => e.id), [1, 2, 3]);
  assert.ok(employees.items[0].department.name);
  assert.ok(employees.items[0].department.employeeCount >= 1);

  const one = await api().get('/graphql').query({ query: '{ product(id: 1) { id sku category { name } createdAt } }' }).expect(200);
  assert.equal(one.body.data.product.id, 1);
  assert.ok(one.body.data.product.category.name);
  assert.equal((await gql('{ employee(id: 999999) { id } }').expect(200)).body.data.employee, null);
});

test('filters, search, sort and Relay connections', async () => {
  const f = (await gql('{ employees(limit: 100, filter: [{ field: "level", value: "L3" }, { field: "salary", op: gte, value: "1" }], sort: "-salary") { total items { level salary } } }').expect(200)).body;
  assert.equal(f.errors, undefined, JSON.stringify(f.errors));
  assert.ok(f.data.employees.items.every((e) => e.level === 'L3' && e.salary >= 1));
  const sal = f.data.employees.items.map((e) => e.salary);
  assert.deepEqual(sal, [...sal].sort((a, b) => b - a));

  const bad = (await gql('{ employees(filter: [{ field: "nope", value: "x" }]) { total } }').expect(200)).body;
  assert.equal(bad.data, null);
  assert.equal(bad.errors[0].extensions.code, 'BAD_REQUEST');
  assert.deepEqual(bad.errors[0].path, ['employees']);

  const p1 = (await gql('{ productsConnection(first: 2) { totalCount edges { cursor node { id } } pageInfo { hasNextPage hasPreviousPage endCursor } } }').expect(200)).body.data.productsConnection;
  assert.deepEqual(p1.edges.map((e) => e.node.id), [1, 2]);
  assert.equal(p1.pageInfo.hasNextPage, true);
  assert.equal(p1.pageInfo.hasPreviousPage, false);
  const p2 = (await gql('query($a: String) { productsConnection(first: 2, after: $a) { nodes { id } pageInfo { hasPreviousPage startCursor } } }', { a: p1.pageInfo.endCursor }).expect(200)).body.data.productsConnection;
  assert.deepEqual(p2.nodes.map((n) => n.id), [3, 4]);
  assert.equal(p2.pageInfo.hasPreviousPage, true);
  const back = (await gql('query($b: String) { productsConnection(last: 1, before: $b) { nodes { id } } }', { b: p2.pageInfo.startCursor }).expect(200)).body.data.productsConnection;
  assert.deepEqual(back.nodes.map((n) => n.id), [2]);
  const badCursor = (await gql('{ productsConnection(after: "zzz") { totalCount } }').expect(200)).body;
  assert.equal(badCursor.errors[0].extensions.problemCode, 'invalid-cursor');
  const big = (await gql('{ departments(limit: 500) { total } }').expect(200)).body;
  assert.equal(big.errors[0].extensions.code, 'BAD_REQUEST');
});

test('mutations: create, update (merge patch), validation, not found, conflict, delete; changes reach /v1', async () => {
  const c = (await gql('mutation($in: DepartmentInput!) { createDepartment(input: $in) { id name code employeeCount } }', { in: { name: 'GraphQL Dept', code: 'GQL-1' } }).expect(200)).body;
  assert.equal(c.errors, undefined, JSON.stringify(c.errors));
  const id = c.data.createDepartment.id;
  assert.equal((await api().get(`/v1/departments/${id}`).expect(200)).body.code, 'GQL-1');

  const e = (await gql('mutation($in: EmployeeInput!) { createEmployee(input: $in) { id employeeNumber department { code } address { city } } }', {
    in: { firstName: 'Graph', lastName: 'Q', email: 'graph.q@example.com', departmentId: id, address: { city: 'Ottawa', countryCode: 'CA' } },
  }).expect(200)).body;
  assert.equal(e.errors, undefined, JSON.stringify(e.errors));
  const empId = e.data.createEmployee.id;
  assert.match(e.data.createEmployee.employeeNumber, /^EMP-\d{6}$/);
  assert.equal(e.data.createEmployee.department.code, 'GQL-1');

  const u = (await gql('mutation($id: Int!) { updateEmployee(id: $id, input: { title: "Engineer", address: { city: "Toronto" } }) { title address { city countryCode } } }', { id: empId }).expect(200)).body;
  assert.equal(u.data.updateEmployee.title, 'Engineer');
  assert.deepEqual(u.data.updateEmployee.address, { city: 'Toronto', countryCode: 'CA' });

  const invalid = (await gql('mutation { createDepartment(input: { name: "x", code: "lower case" }) { id } }').expect(200)).body;
  assert.equal(invalid.data, null);
  assert.equal(invalid.errors[0].extensions.code, 'BAD_USER_INPUT');
  assert.equal(invalid.errors[0].extensions.status, 422);
  assert.ok(invalid.errors[0].extensions.errors.some((x) => x.field === 'code'));

  const missing = (await gql('mutation { deleteCategory(id: 999999) { deleted } }').expect(200)).body;
  assert.equal(missing.errors[0].extensions.code, 'NOT_FOUND');

  const inUse = (await gql(`mutation { deleteDepartment(id: ${id}) { deleted } }`).expect(200)).body;
  assert.equal(inUse.errors[0].extensions.code, 'CONFLICT');

  assert.deepEqual((await gql(`mutation { deleteEmployee(id: ${empId}) { id deleted } }`).expect(200)).body.data.deleteEmployee, { id: empId, deleted: true });
  assert.equal((await gql(`mutation { deleteDepartment(id: ${id}) { deleted } }`).expect(200)).body.data.deleteDepartment.deleted, true);
  await api().get(`/v1/departments/${id}`).expect(404);
});

test('request errors: parse, validation, media types, GET mutation, bad body', async () => {
  const parse = (await gql('{ employees { ').expect(200)).body;
  assert.equal('data' in parse, false);
  assert.equal(parse.errors[0].extensions.code, 'GRAPHQL_PARSE_FAILED');

  const v = await api().post('/graphql').set('Accept', 'application/graphql-response+json').send({ query: '{ nope }' }).expect(400);
  assert.match(v.get('Content-Type'), /^application\/graphql-response\+json/);
  assert.equal(v.body.errors[0].extensions.code, 'GRAPHQL_VALIDATION_FAILED');

  const varErr = (await gql('query($id: Int!) { employee(id: $id) { id } }', { id: 'abc' }).expect(200)).body;
  assert.equal('data' in varErr, false);

  await api().post('/graphql').send({ variables: {} }).expect(400);
  const g = await api().get('/graphql').query({ query: 'mutation { deleteCategory(id: 1) { deleted } }' }).expect(405);
  assert.equal(g.get('Allow'), 'POST');
  assert.equal(g.body.errors[0].extensions.code, 'METHOD_NOT_ALLOWED');
  await api().post('/graphql').set('Content-Type', 'text/plain').send('{ counts { employees } }').expect(415);
  const raw = await api().post('/graphql').set('Content-Type', 'application/graphql').send('{ counts { employees } }').expect(200);
  assert.ok(raw.body.data.counts.employees > 0);
  const broken = await api().post('/graphql').set('Content-Type', 'application/json').send('{"query": ').expect(400);
  assert.ok(broken.body.errors[0].message);
  assert.equal((await gql('subscription { changes { id } }').expect(200)).body.errors[0].extensions.code, 'SUBSCRIPTION_NOT_SUPPORTED_OVER_HTTP');
  await api().put('/graphql').send({}).expect(405);
  await api().get('/graphql/nope').expect(404);
});

test('shared stack (auth, transport chaos) and injected field errors', async () => {
  await set('authMode', 'bearer');
  try {
    const r = await gql('{ counts { employees } }').expect(401);
    assert.ok(r.get('WWW-Authenticate'));
    assert.equal(r.body.errors[0].extensions.code, 'UNAUTHENTICATED');
    assert.equal('data' in r.body, false);
    await gql('{ counts { employees } }', undefined, { Authorization: 'Bearer demo-token' }).expect(200);
    await api().get('/graphql/schema.graphql').expect(200); // the contract stays open
  } finally { await set('authMode', 'none'); }

  const forced = await gql('{ counts { employees } }', undefined, { 'X-Force-Error': '503' }).expect(503);
  assert.equal(forced.body.errors[0].extensions.code, 'SERVICE_UNAVAILABLE');

  const partial = (await gql('{ employees(limit: 2) { items { id department { name } } } }', undefined, { 'X-Force-GraphQL-Error': 'department' }).expect(200)).body;
  assert.equal(partial.data.employees.items.length, 2);
  assert.equal(partial.data.employees.items[0].department, null);
  assert.equal(partial.errors.length, 2);
  assert.deepEqual(partial.errors[0].path, ['employees', 'items', 0, 'department']);
  assert.equal(partial.errors[0].extensions.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(partial.errors[0].extensions.injected, true);
  const typed = (await gql('{ counts { employees } }', undefined, { 'X-Force-GraphQL-Error': 'Query.counts:403' }).expect(200)).body;
  assert.equal(typed.data, null);
  assert.equal(typed.errors[0].extensions.code, 'FORBIDDEN');
});

test('settings: introspection, max depth, disabled', async () => {
  const intro = (await gql('{ __schema { queryType { name } } }').expect(200)).body;
  assert.equal(intro.data.__schema.queryType.name, 'Query');
  await set('graphqlIntrospection', false);
  try {
    const off = (await gql('{ __schema { queryType { name } } }').expect(200)).body;
    assert.equal(off.errors[0].extensions.code, 'GRAPHQL_VALIDATION_FAILED');
    assert.equal((await gql('{ counts { employees } }').expect(200)).body.errors, undefined);
  } finally { await set('graphqlIntrospection', true); }

  await set('graphqlMaxDepth', 3);
  try {
    const deep = (await gql('{ employees { items { manager { manager { id } } } } }').expect(200)).body;
    assert.equal(deep.errors[0].extensions.code, 'QUERY_TOO_DEEP');
    const viaFragment = (await gql('{ employees { items { ...M } } } fragment M on Employee { department { id } }').expect(200)).body;
    assert.equal(viaFragment.errors[0].extensions.code, 'QUERY_TOO_DEEP');
    assert.equal((await gql('{ employees { items { id } } }').expect(200)).body.errors, undefined);
  } finally { await set('graphqlMaxDepth', 10); }

  await set('graphqlEnabled', false);
  try { await gql('{ counts { employees } }').expect(404); } finally { await set('graphqlEnabled', true); }
});

test('subscriptions and operations over graphql-transport-ws', async () => {
  const wsUrl = `${t.url.replace(/^http/, 'ws')}/graphql`;
  const c = await connect(wsUrl, { protocols: ['graphql-transport-ws'] });
  assert.equal(c.status, 101);
  assert.equal(c.protocol, 'graphql-transport-ws');
  const msgs = [];
  const waiters = [];
  c.conn.on('message', (m) => { msgs.push(JSON.parse(m.data)); waiters.splice(0).forEach((f) => f()); });
  c.conn.on('error', () => {});
  const until = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const tm = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(msgs)}`)), ms);
    const check = () => { const m = msgs.find(pred); if (m) { clearTimeout(tm); resolve(m); } else waiters.push(check); };
    check();
  });
  const send = (m) => c.conn.send(JSON.stringify(m));

  send({ type: 'connection_init' });
  await until((m) => m.type === 'connection_ack');
  send({ type: 'ping' });
  await until((m) => m.type === 'pong');

  send({ id: 'q1', type: 'subscribe', payload: { query: '{ department(id: 1) { id } }' } });
  assert.equal((await until((m) => m.id === 'q1' && m.type === 'next')).payload.data.department.id, 1);
  await until((m) => m.id === 'q1' && m.type === 'complete');

  send({ id: 'bad', type: 'subscribe', payload: { query: '{ nope }' } });
  assert.equal((await until((m) => m.id === 'bad' && m.type === 'error')).payload[0].extensions.code, 'GRAPHQL_VALIDATION_FAILED');

  send({ id: 's1', type: 'subscribe', payload: { query: 'subscription { changes(resources: [categories]) { type resource id data } }' } });
  await new Promise((r) => setTimeout(r, 100));
  await api().patch('/v1/departments/1').set('Content-Type', 'application/merge-patch+json').send({ name: (await api().get('/v1/departments/1')).body.name }).expect(200); // filtered out
  const cat = (await api().post('/v1/categories').send({ name: 'GQL Sub', code: 'GQLSUB' }).expect(201)).body;
  const ev = await until((m) => m.id === 's1' && m.type === 'next');
  assert.deepEqual({ type: ev.payload.data.changes.type, resource: ev.payload.data.changes.resource, id: ev.payload.data.changes.id }, { type: 'created', resource: 'categories', id: cat.id });
  assert.equal(ev.payload.data.changes.data.code, 'GQLSUB');
  send({ id: 's1', type: 'complete' });
  await api().delete(`/v1/categories/${cat.id}`).expect(204);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(msgs.filter((m) => m.id === 's1' && m.type === 'next').length, 1);

  const closed = new Promise((resolve) => c.conn.on('close', resolve));
  send({ type: 'connection_init' });
  assert.equal((await closed).code, 4429);

  // Wrong subprotocol and subscribe-before-ack
  const w = await connect(wsUrl, { protocols: ['graphql-ws'] });
  assert.equal((await new Promise((resolve) => w.conn.on('close', resolve))).code, 4406);
  const n = await connect(wsUrl, { protocols: ['graphql-transport-ws'] });
  n.conn.send(JSON.stringify({ id: 'x', type: 'subscribe', payload: { query: '{ counts { employees } }' } }));
  assert.equal((await new Promise((resolve) => n.conn.on('close', resolve))).code, 4401);

  // The upgrade goes through auth
  await set('authMode', 'bearer');
  try {
    assert.equal((await connect(wsUrl, { protocols: ['graphql-transport-ws'] })).status, 401);
    assert.equal((await connect(`${wsUrl}?access_token=demo-token`, { protocols: ['graphql-transport-ws'] })).status, 101);
  } finally { await set('authMode', 'none'); }
});
