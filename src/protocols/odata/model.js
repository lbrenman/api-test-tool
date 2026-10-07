'use strict';
// OData v4 entity data model over the shared mock data, and its CSDL ($metadata).
//
// Property names are the same as /v1 (camelCase) so payloads look alike across protocols. The free-form
// Employee.metadata object has no OData type and is left out. Timestamps are always ISO 8601
// (Edm.DateTimeOffset) here: OData clients parse them strictly, so DATE_FORMAT does not apply.
const { escapeXml } = require('../../util/xml');

const NS = 'ApiTestTool';

// type: Edm.* or a complex type name; coll: Collection(...); nn: Nullable="false"
const P = (name, type, opts = {}) => ({ name, type, ...opts });

const COMPLEX = {
  Geo: [P('lat', 'Edm.Double'), P('lng', 'Edm.Double')],
  Address: [P('street', 'Edm.String'), P('city', 'Edm.String'), P('region', 'Edm.String'), P('postalCode', 'Edm.String'), P('countryCode', 'Edm.String'), P('geo', 'Geo')],
  Certification: [P('name', 'Edm.String', { nn: true }), P('issuedAt', 'Edm.DateTimeOffset', { nn: true }), P('expiresAt', 'Edm.DateTimeOffset')],
  PhoneNumber: [P('type', 'Edm.String', { nn: true }), P('number', 'Edm.String', { nn: true })],
  Dimensions: [P('l', 'Edm.Double'), P('w', 'Edm.Double'), P('h', 'Edm.Double'), P('unit', 'Edm.String')],
  Variant: [P('sku', 'Edm.String', { nn: true }), P('color', 'Edm.String'), P('size', 'Edm.String'), P('priceDelta', 'Edm.Double')],
};

const common = [P('id', 'Edm.Int32', { nn: true, key: true, computed: true }), P('uuid', 'Edm.Guid', { computed: true })];
const stamps = [P('createdAt', 'Edm.DateTimeOffset', { nn: true, computed: true }), P('updatedAt', 'Edm.DateTimeOffset', { nn: true, computed: true })];

// nav: { name, target (entity set), many, fk (property on this entity) | reverse (property on the target) }
const ENTITIES = {
  Employee: {
    set: 'Employees', resource: 'employees',
    props: [...common,
      P('employeeNumber', 'Edm.String'), P('firstName', 'Edm.String', { nn: true }), P('lastName', 'Edm.String', { nn: true }), P('email', 'Edm.String', { nn: true }),
      P('title', 'Edm.String'), P('level', 'Edm.String'), P('isActive', 'Edm.Boolean'), P('salary', 'Edm.Double'), P('salaryDecimal', 'Edm.String'),
      P('performanceRating', 'Edm.Double'), P('departmentId', 'Edm.Int32', { nn: true }), P('managerId', 'Edm.Int32'),
      P('skills', 'Edm.String', { coll: true }), P('certifications', 'Certification', { coll: true }), P('address', 'Address'),
      P('phoneNumbers', 'PhoneNumber', { coll: true }), P('hireDate', 'Edm.Date'), P('avatarFileId', 'Edm.String'), ...stamps],
    nav: [
      { name: 'department', target: 'Departments', fk: 'departmentId', partner: 'employees', nn: true },
      { name: 'manager', target: 'Employees', fk: 'managerId', partner: 'directReports' },
      { name: 'directReports', target: 'Employees', many: true, reverse: 'managerId', partner: 'manager' },
    ],
  },
  Product: {
    set: 'Products', resource: 'products',
    props: [...common,
      P('sku', 'Edm.String', { nn: true }), P('name', 'Edm.String', { nn: true }), P('description', 'Edm.String'), P('price', 'Edm.Double', { nn: true }),
      P('priceDecimal', 'Edm.String'), P('currency', 'Edm.String', { nn: true }), P('inStock', 'Edm.Boolean'), P('stockQty', 'Edm.Int32'),
      P('weightKg', 'Edm.Double'), P('dimensions', 'Dimensions'), P('tags', 'Edm.String', { coll: true }), P('variants', 'Variant', { coll: true }),
      P('categoryId', 'Edm.Int32', { nn: true }), P('rating', 'Edm.Double'), P('releaseDate', 'Edm.Date'), P('discontinuedAt', 'Edm.DateTimeOffset'),
      P('imageFileIds', 'Edm.String', { coll: true }), ...stamps],
    nav: [{ name: 'category', target: 'Categories', fk: 'categoryId', partner: 'products', nn: true }],
  },
  Department: {
    set: 'Departments', resource: 'departments',
    props: [...common, P('name', 'Edm.String', { nn: true }), P('code', 'Edm.String', { nn: true }), ...stamps],
    nav: [{ name: 'employees', target: 'Employees', many: true, reverse: 'departmentId', partner: 'department' }],
  },
  Category: {
    set: 'Categories', resource: 'categories',
    props: [...common, P('name', 'Edm.String', { nn: true }), P('code', 'Edm.String', { nn: true }), ...stamps],
    nav: [{ name: 'products', target: 'Products', many: true, reverse: 'categoryId', partner: 'category' }],
  },
};

const SETS = Object.fromEntries(Object.entries(ENTITIES).map(([type, e]) => [e.set, { ...e, type }]));
const typeOf = (set) => SETS[set];

const qualified = (t) => (t.startsWith('Edm.') ? t : `${NS}.${t}`);
const typeAttr = (p) => (p.coll ? `Collection(${qualified(p.type)})` : qualified(p.type));

function propXml(p) {
  return `<Property Name="${p.name}" Type="${typeAttr(p)}"${p.nn || p.coll ? ' Nullable="false"' : ''}/>`;
}

function generateCsdl() {
  const out = ['<?xml version="1.0" encoding="utf-8"?>',
    '<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">',
    '<edmx:Reference Uri="https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Core.V1.xml"><edmx:Include Namespace="Org.OData.Core.V1" Alias="Core"/></edmx:Reference>',
    '<edmx:DataServices>',
    `<Schema Namespace="${NS}" xmlns="http://docs.oasis-open.org/odata/ns/edm">`];
  for (const [name, e] of Object.entries(ENTITIES)) {
    out.push(`<EntityType Name="${name}">`, '<Key><PropertyRef Name="id"/></Key>');
    for (const p of e.props) {
      if (p.computed) out.push(`<Property Name="${p.name}" Type="${typeAttr(p)}"${p.nn ? ' Nullable="false"' : ''}><Annotation Term="Core.Computed" Bool="true"/></Property>`);
      else out.push(propXml(p));
    }
    for (const n of e.nav) {
      const t = `${NS}.${SETS[n.target].type}`;
      out.push(`<NavigationProperty Name="${n.name}" Type="${n.many ? `Collection(${t})` : t}"${!n.many && n.nn ? ' Nullable="false"' : ''} Partner="${n.partner}">`
        + `${n.fk ? `<ReferentialConstraint Property="${n.fk}" ReferencedProperty="id"/>` : ''}</NavigationProperty>`);
    }
    out.push('</EntityType>');
  }
  for (const [name, props] of Object.entries(COMPLEX)) out.push(`<ComplexType Name="${name}">${props.map(propXml).join('')}</ComplexType>`);
  out.push('<EntityContainer Name="Container">');
  for (const [name, e] of Object.entries(ENTITIES)) {
    out.push(`<EntitySet Name="${e.set}" EntityType="${NS}.${name}">${e.nav.map((n) => `<NavigationPropertyBinding Path="${escapeXml(n.name)}" Target="${n.target}"/>`).join('')}</EntitySet>`);
  }
  out.push('</EntityContainer>', '</Schema>', '</edmx:DataServices>', '</edmx:Edmx>');
  return out.join('\n');
}

// Property lookup on an entity or complex type: { kind: 'prop', prop } | { kind: 'nav', nav } | null
function member(typeName, name) {
  const e = ENTITIES[typeName];
  const props = e ? e.props : COMPLEX[typeName];
  if (!props) return null;
  const prop = props.find((p) => p.name === name);
  if (prop) return { kind: 'prop', prop };
  const nav = e?.nav.find((n) => n.name === name);
  return nav ? { kind: 'nav', nav } : null;
}

// Keep only modelled properties (in model order) — drops e.g. metadata.
function shape(typeName, doc) {
  const out = {};
  for (const p of ENTITIES[typeName].props) {
    let v = doc[p.name];
    if (v === undefined) v = p.coll ? [] : null;
    out[p.name] = v;
  }
  return out;
}

module.exports = { NS, ENTITIES, COMPLEX, SETS, typeOf, member, shape, generateCsdl, qualified };
