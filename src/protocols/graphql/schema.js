'use strict';
// GraphQL schema over the shared mock data. The SDL below is the contract (served at
// /graphql/schema.graphql); resolvers are attached to the built schema in makeSchema().
//
// Every resolver goes through ResourceService, so validation, reference checks and change events are
// the same as /v1 and /soap. Timestamps are formatted with DATE_FORMAT (the DateTime scalar passes the
// formatted value through: an ISO string by default, a number for the epoch formats).
const {
  buildSchema, GraphQLScalarType, Kind, valueFromASTUntyped, defaultFieldResolver, GraphQLError, isObjectType,
} = require('graphql');
const { HttpError } = require('../../util/problem');
const { applyQuery } = require('../../services/query');
const { NAMES, SINGULAR } = require('../../services/resources');
const { toGraphQLError } = require('./errors');

const MAX_PAGE = 100;

const SDL = /* GraphQL */ `
"""
Timestamp formatted with the server's DATE_FORMAT setting (ISO 8601 by default; a number for the
epoch formats). Inputs accept any supported timestamp format.
"""
scalar DateTime

"Arbitrary JSON value (used for free-form metadata and change payloads)."
scalar JSON

enum Level { L1 L2 L3 L4 L5 L6 L7 }
enum PhoneType { mobile work home fax }
enum Currency { USD EUR GBP JPY CAD }
enum DimensionUnit { cm in }
enum Size { XS S M L XL }
enum Resource { employees products departments categories }
enum ChangeType { created updated deleted }

"Comparison used by a filter condition (same operators as the REST API's field[op]=value filters)."
enum FilterOp { eq ne gt gte lt lte in nin like exists }

"""
One filter condition, e.g. { field: "level", value: "L3" } or { field: "salary", op: gte, value: "90000" }.
field may be a dotted path (address.city). Values are strings and are converted to the field's type;
use a comma-separated list for in / nin, and "true" / "false" for exists.
"""
input FilterInput {
  field: String!
  op: FilterOp = eq
  value: String
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

type Geo { lat: Float, lng: Float }
type Address { street: String, city: String, region: String, postalCode: String, countryCode: String, geo: Geo }
type Certification { name: String!, issuedAt: DateTime!, expiresAt: DateTime }
type PhoneNumber { type: PhoneType!, number: String! }
type Dimensions { l: Float, w: Float, h: Float, unit: DimensionUnit }
type Variant { sku: String!, color: String, size: Size, priceDelta: Float }

type Employee {
  id: Int!
  uuid: ID!
  employeeNumber: String!
  firstName: String!
  lastName: String!
  "firstName + lastName"
  fullName: String!
  email: String!
  title: String
  level: Level!
  isActive: Boolean!
  salary: Float
  "Decimal amount as a string"
  salaryDecimal: String
  performanceRating: Float
  departmentId: Int!
  department: Department
  managerId: Int
  manager: Employee
  directReports: [Employee!]!
  skills: [String!]!
  certifications: [Certification!]!
  address: Address
  phoneNumbers: [PhoneNumber!]!
  hireDate: String
  metadata: JSON
  avatarFileId: String
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Product {
  id: Int!
  uuid: ID!
  sku: String!
  name: String!
  description: String
  price: Float!
  priceDecimal: String!
  currency: Currency!
  inStock: Boolean!
  stockQty: Int
  weightKg: Float
  dimensions: Dimensions
  tags: [String!]!
  variants: [Variant!]!
  categoryId: Int!
  category: Category
  rating: Float
  releaseDate: String
  discontinuedAt: DateTime
  imageFileIds: [String!]!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Department {
  id: Int!
  uuid: ID!
  name: String!
  code: String!
  employeeCount: Int!
  employees(limit: Int = 10, offset: Int = 0, sort: String): [Employee!]!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Category {
  id: Int!
  uuid: ID!
  name: String!
  code: String!
  productCount: Int!
  products(limit: Int = 10, offset: Int = 0, sort: String): [Product!]!
  createdAt: DateTime!
  updatedAt: DateTime!
}

"Offset page: items plus the total number of matches."
type EmployeePage { items: [Employee!]!, total: Int!, limit: Int!, offset: Int! }
type ProductPage { items: [Product!]!, total: Int!, limit: Int!, offset: Int! }
type DepartmentPage { items: [Department!]!, total: Int!, limit: Int!, offset: Int! }
type CategoryPage { items: [Category!]!, total: Int!, limit: Int!, offset: Int! }

type EmployeeEdge { cursor: String!, node: Employee! }
type ProductEdge { cursor: String!, node: Product! }
type DepartmentEdge { cursor: String!, node: Department! }
type CategoryEdge { cursor: String!, node: Category! }

"Relay-style connection (first/after forward, last/before backward)."
type EmployeeConnection { edges: [EmployeeEdge!]!, nodes: [Employee!]!, pageInfo: PageInfo!, totalCount: Int! }
type ProductConnection { edges: [ProductEdge!]!, nodes: [Product!]!, pageInfo: PageInfo!, totalCount: Int! }
type DepartmentConnection { edges: [DepartmentEdge!]!, nodes: [Department!]!, pageInfo: PageInfo!, totalCount: Int! }
type CategoryConnection { edges: [CategoryEdge!]!, nodes: [Category!]!, pageInfo: PageInfo!, totalCount: Int! }

type Counts { employees: Int!, products: Int!, departments: Int!, categories: Int! }

type Query {
  employee(id: Int!): Employee
  "sort: comma list of fields, - for descending (e.g. \\"-salary,lastName\\"); search: free text across all fields."
  employees(limit: Int = 10, offset: Int = 0, filter: [FilterInput!], sort: String, search: String): EmployeePage!
  employeesConnection(first: Int, after: String, last: Int, before: String, filter: [FilterInput!], sort: String, search: String): EmployeeConnection!

  product(id: Int!): Product
  products(limit: Int = 10, offset: Int = 0, filter: [FilterInput!], sort: String, search: String): ProductPage!
  productsConnection(first: Int, after: String, last: Int, before: String, filter: [FilterInput!], sort: String, search: String): ProductConnection!

  department(id: Int!): Department
  departments(limit: Int = 10, offset: Int = 0, filter: [FilterInput!], sort: String, search: String): DepartmentPage!
  departmentsConnection(first: Int, after: String, last: Int, before: String, filter: [FilterInput!], sort: String, search: String): DepartmentConnection!

  category(id: Int!): Category
  categories(limit: Int = 10, offset: Int = 0, filter: [FilterInput!], sort: String, search: String): CategoryPage!
  categoriesConnection(first: Int, after: String, last: Int, before: String, filter: [FilterInput!], sort: String, search: String): CategoryConnection!

  "Record counts per resource."
  counts: Counts!
}

input GeoInput { lat: Float, lng: Float }
input AddressInput { street: String, city: String, region: String, postalCode: String, countryCode: String, geo: GeoInput }
input CertificationInput { name: String!, issuedAt: DateTime!, expiresAt: DateTime }
input PhoneNumberInput { type: PhoneType!, number: String! }
input DimensionsInput { l: Float, w: Float, h: Float, unit: DimensionUnit }
input VariantInput { sku: String!, color: String, size: Size, priceDelta: Float }

input EmployeeInput {
  firstName: String!
  lastName: String!
  email: String!
  departmentId: Int!
  employeeNumber: String
  title: String
  level: Level
  isActive: Boolean
  salary: Float
  salaryDecimal: String
  performanceRating: Float
  managerId: Int
  skills: [String!]
  certifications: [CertificationInput!]
  address: AddressInput
  phoneNumbers: [PhoneNumberInput!]
  hireDate: String
  metadata: JSON
  avatarFileId: String
}

"Partial update (JSON Merge Patch semantics): omitted fields are kept, null removes or resets a field."
input EmployeePatch {
  firstName: String
  lastName: String
  email: String
  departmentId: Int
  employeeNumber: String
  title: String
  level: Level
  isActive: Boolean
  salary: Float
  salaryDecimal: String
  performanceRating: Float
  managerId: Int
  skills: [String!]
  certifications: [CertificationInput!]
  address: AddressInput
  phoneNumbers: [PhoneNumberInput!]
  hireDate: String
  metadata: JSON
  avatarFileId: String
}

input ProductInput {
  name: String!
  sku: String!
  price: Float!
  currency: Currency!
  categoryId: Int!
  description: String
  priceDecimal: String
  inStock: Boolean
  stockQty: Int
  weightKg: Float
  dimensions: DimensionsInput
  tags: [String!]
  variants: [VariantInput!]
  rating: Float
  releaseDate: String
  discontinuedAt: DateTime
  imageFileIds: [String!]
}

"Partial update (JSON Merge Patch semantics)."
input ProductPatch {
  name: String
  sku: String
  price: Float
  currency: Currency
  categoryId: Int
  description: String
  priceDecimal: String
  inStock: Boolean
  stockQty: Int
  weightKg: Float
  dimensions: DimensionsInput
  tags: [String!]
  variants: [VariantInput!]
  rating: Float
  releaseDate: String
  discontinuedAt: DateTime
  imageFileIds: [String!]
}

input DepartmentInput { name: String!, code: String! }
input DepartmentPatch { name: String, code: String }
input CategoryInput { name: String!, code: String! }
input CategoryPatch { name: String, code: String }

type DeleteResult { id: Int!, deleted: Boolean! }

type Mutation {
  createEmployee(input: EmployeeInput!): Employee!
  updateEmployee(id: Int!, input: EmployeePatch!): Employee!
  deleteEmployee(id: Int!): DeleteResult!

  createProduct(input: ProductInput!): Product!
  updateProduct(id: Int!, input: ProductPatch!): Product!
  deleteProduct(id: Int!): DeleteResult!

  createDepartment(input: DepartmentInput!): Department!
  updateDepartment(id: Int!, input: DepartmentPatch!): Department!
  deleteDepartment(id: Int!): DeleteResult!

  createCategory(input: CategoryInput!): Category!
  updateCategory(id: Int!, input: CategoryPatch!): Category!
  deleteCategory(id: Int!): DeleteResult!
}

"A record was created, updated or deleted (through GraphQL, /v1, /soap or the back office)."
type Change {
  type: ChangeType!
  resource: Resource!
  id: Int!
  at: DateTime!
  "The record after the change (absent for deletes)"
  data: JSON
}

type Subscription {
  "Live change feed (graphql-transport-ws over WebSocket on /graphql). Omit resources for all of them."
  changes(resources: [Resource!]): Change!
}
`;

// ---- scalars ---------------------------------------------------------------------------------

const DateTime = {
  serialize(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' || typeof v === 'number') return v;
    if (v instanceof Date) return v.toISOString();
    throw new GraphQLError(`DateTime cannot represent ${typeof v}`);
  },
  parseValue(v) {
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return v;
    throw new GraphQLError('DateTime expects a string or a number');
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING) return ast.value;
    if (ast.kind === Kind.INT || ast.kind === Kind.FLOAT) return Number(ast.value);
    throw new GraphQLError('DateTime expects a string or a number', { nodes: ast });
  },
};

const JSONScalar = {
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: (ast, variables) => valueFromASTUntyped(ast, variables),
};

// ---- helpers ---------------------------------------------------------------------------------

const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))); // input objects have a null prototype

function checkPage(limit, offset) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new HttpError(400, `limit must be between 1 and ${MAX_PAGE}`, { code: 'invalid-parameter', errors: [{ field: 'limit', message: `must be 1-${MAX_PAGE}` }] });
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'offset must be 0 or more', { code: 'invalid-parameter', errors: [{ field: 'offset', message: 'must be >= 0' }] });
}

// filter: [{ field, op, value }] -> the query object the REST filters use ({ field: { op: value } }).
function toQuery({ filter, sort, search }) {
  const q = {};
  for (const f of filter || []) {
    if (f.field.startsWith('_')) throw new HttpError(400, `Unknown filter field "${f.field}"`, { code: 'invalid-filter' });
    q[f.field] = { ...(q[f.field] || {}), [f.op || 'eq']: f.value ?? 'null' };
  }
  if (sort) q.sort = sort;
  if (search) q.q = search;
  return q;
}

const cursorOf = (i) => Buffer.from(`offset:${i}`).toString('base64url');
function offsetOf(cursor, arg) {
  const m = /^offset:(\d+)$/.exec(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  if (!m) throw new HttpError(400, `Invalid cursor in "${arg}"`, { code: 'invalid-cursor', errors: [{ field: arg, message: 'not a cursor returned by this API' }] });
  return Number(m[1]);
}

// Relay pagination over an already filtered/sorted list.
function connection(list, { first, after, last, before }) {
  for (const [k, v] of Object.entries({ first, last })) {
    if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 0 || v > MAX_PAGE)) {
      throw new HttpError(400, `${k} must be between 0 and ${MAX_PAGE}`, { code: 'invalid-parameter', errors: [{ field: k, message: `must be 0-${MAX_PAGE}` }] });
    }
  }
  let start = after != null ? offsetOf(after, 'after') + 1 : 0;
  let end = before != null ? Math.min(offsetOf(before, 'before'), list.length) : list.length;
  start = Math.min(start, end);
  if (first == null && last == null) first = 10;
  if (first != null) end = Math.min(end, start + first);
  if (last != null) start = Math.max(start, end - last);
  const edges = list.slice(start, end).map((node, i) => ({ cursor: cursorOf(start + i), node }));
  return {
    edges,
    nodes: edges.map((e) => e.node),
    totalCount: list.length,
    pageInfo: {
      hasNextPage: end < list.length,
      hasPreviousPage: start > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
  };
}

// A push-based async iterator over ctx.events 'change' (for subscriptions).
function changeIterator(events, filter) {
  const queue = [];
  const waiting = [];
  let done = false;
  const onChange = (e) => {
    if (filter && !filter(e)) return;
    if (waiting.length) waiting.shift()({ value: e, done: false });
    else if (queue.length < 1000) queue.push(e);
  };
  events.on('change', onChange);
  const stop = () => {
    if (done) return;
    done = true;
    events.off('change', onChange);
    while (waiting.length) waiting.shift()({ value: undefined, done: true });
  };
  return {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiting.push(resolve));
    },
    return() { stop(); return Promise.resolve({ value: undefined, done: true }); },
    throw(err) { stop(); return Promise.reject(err); },
    [Symbol.asyncIterator]() { return this; },
  };
}

// ---- schema ----------------------------------------------------------------------------------

const TYPE_OF = { employees: 'Employee', products: 'Product', departments: 'Department', categories: 'Category' };

function makeSchema(ctx) {
  const schema = buildSchema(SDL);
  const res = ctx.resources;
  const fmt = (doc) => (doc ? ctx.dates.formatDoc(doc) : doc);

  Object.assign(schema.getType('DateTime'), DateTime);
  Object.assign(schema.getType('JSON'), JSONScalar);

  const field = (type, name, resolve) => { schema.getType(type).getFields()[name].resolve = resolve; };
  const getOne = async (name, id) => fmt(await res.get(name, id));
  const mustGet = async (name, id) => {
    const doc = await res.get(name, id);
    if (!doc) throw new HttpError(404, `${SINGULAR[name]} ${id} not found`, { code: 'not-found' });
    return doc;
  };
  const listOf = async (name, args) => {
    const all = await res.render(name, await res.all(name)); // nested summaries make department.name etc. filterable
    return applyQuery(all, toQuery(args), { parseDate: ctx.dates.parseValue });
  };

  for (const name of NAMES) {
    const singular = SINGULAR[name];
    const Type = TYPE_OF[name];
    field('Query', singular, (_, { id }) => getOne(name, id));
    field('Query', name, async (_, args) => {
      checkPage(args.limit, args.offset);
      const list = await listOf(name, args);
      return { items: list.slice(args.offset, args.offset + args.limit).map(fmt), total: list.length, limit: args.limit, offset: args.offset };
    });
    field('Query', `${name}Connection`, async (_, args) => {
      const c = connection(await listOf(name, args), args);
      c.edges = c.edges.map((e) => ({ ...e, node: fmt(e.node) }));
      c.nodes = c.edges.map((e) => e.node);
      return c;
    });
    field('Mutation', `create${Type}`, async (_, { input }) => fmt(await res.create(name, plain(input))));
    field('Mutation', `update${Type}`, async (_, { id, input }) => fmt(await res.patch(name, await mustGet(name, id), plain(input))));
    field('Mutation', `delete${Type}`, async (_, { id }) => { await res.remove(name, await mustGet(name, id)); return { id, deleted: true }; });
  }
  field('Query', 'counts', () => res.counts());

  field('Employee', 'fullName', (e) => `${e.firstName} ${e.lastName}`);
  field('Employee', 'department', (e) => getOne('departments', e.departmentId));
  field('Employee', 'manager', (e) => (e.managerId ? getOne('employees', e.managerId) : null));
  field('Employee', 'directReports', async (e) => (await res.all('employees')).filter((x) => x.managerId === e.id).map(fmt));
  field('Product', 'category', (p) => getOne('categories', p.categoryId));
  const children = (childName, key) => async (parent, args) => {
    checkPage(args.limit, args.offset);
    const list = applyQuery((await res.all(childName)).filter((x) => x[key] === parent.id), args.sort ? { sort: args.sort } : {});
    return list.slice(args.offset, args.offset + args.limit).map(fmt);
  };
  field('Department', 'employees', children('employees', 'departmentId'));
  field('Department', 'employeeCount', async (d) => (await res.all('employees')).filter((x) => x.departmentId === d.id).length);
  field('Category', 'products', children('products', 'categoryId'));
  field('Category', 'productCount', async (c) => (await res.all('products')).filter((x) => x.categoryId === c.id).length);

  const changes = schema.getType('Subscription').getFields().changes;
  changes.subscribe = (_, { resources }) => changeIterator(ctx.events, resources?.length ? (e) => resources.includes(e.resource) : null);
  changes.resolve = (e) => ({ ...e, data: e.data ? fmt(e.data) : null });

  // Every field: chaos (X-Force-GraphQL-Error: fieldName[:CODE], …) and HttpError -> GraphQL error
  // with extensions. Wrapped once here so resolvers stay plain.
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith('__')) continue;
    for (const f of Object.values(type.getFields())) {
      const resolve = f.resolve || defaultFieldResolver;
      f.resolve = (source, args, context, info) => {
        if (context?.forceErrors?.size) {
          const forced = context.forceErrors.get(info.fieldName) || context.forceErrors.get(`${info.parentType.name}.${info.fieldName}`);
          if (forced) throw toGraphQLError(new HttpError(forced.status, `Injected error on ${info.parentType.name}.${info.fieldName} (X-Force-GraphQL-Error)`, { code: forced.code }), { injected: true });
        }
        let out;
        try { out = resolve(source, args, context, info); } catch (e) { throw toGraphQLError(e); }
        return out && typeof out.then === 'function' ? out.then(undefined, (e) => { throw toGraphQLError(e); }) : out;
      };
    }
  }
  return schema;
}

module.exports = { SDL, makeSchema, connection, toQuery, MAX_PAGE };
