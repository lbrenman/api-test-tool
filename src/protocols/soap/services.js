'use strict';
// SOAP services over the shared mock data. Each service is document/literal (wrapped style):
// the Body holds one <tns:OperationName> request element and the answer is <tns:OperationNameResponse>.
const { HttpError } = require('../../util/problem');
const { applyQuery } = require('../../services/query');
const { ENTITIES, entityXml, entityFromXml, scalarIn } = require('./model');
const { elements } = require('../../util/xml');

const NS_BASE = 'urn:api-test-tool:soap:';
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 20;

const SERVICE_DEFS = {
  EmployeeService: {
    title: 'Employees and departments',
    entity: 'Employee', plural: 'Employees', listElement: 'employees',
    filters: [{ name: 'departmentId', type: 'int' }, { name: 'isActive', type: 'boolean' }, { name: 'level', type: 'string' }],
    related: { entity: 'Department', plural: 'Departments', listElement: 'departments' },
    createSample: '<tns:firstName>Ada</tns:firstName><tns:lastName>Lovelace</tns:lastName><tns:email>ada.lovelace@example.com</tns:email><tns:departmentId>1</tns:departmentId>',
    updateSample: '<tns:title>Senior Analyst</tns:title>',
  },
  ProductService: {
    title: 'Products and categories',
    entity: 'Product', plural: 'Products', listElement: 'products',
    filters: [{ name: 'categoryId', type: 'int' }, { name: 'inStock', type: 'boolean' }, { name: 'currency', type: 'string' }],
    related: { entity: 'Category', plural: 'Categories', listElement: 'categories' },
    createSample: '<tns:sku>SOAP-WIDGET-1</tns:sku><tns:name>SOAP widget</tns:name><tns:price>19.99</tns:price><tns:currency>USD</tns:currency><tns:categoryId>1</tns:categoryId>',
    updateSample: '<tns:stockQty>42</tns:stockQty>',
  },
};

const XSD = { string: 'xsd:string', int: 'xsd:int', boolean: 'xsd:boolean' };

// ---------------------------------------------------------------- request parameter parsing
// params: [{ name, type, required?, entity?, mode? }]  entity -> parsed with the entity field table
function readParams(el, params) {
  const errors = [];
  const out = {};
  const byName = new Map(params.map((p) => [p.name, p]));
  for (const c of elements(el)) {
    const p = byName.get(c.local);
    if (!p) { errors.push({ field: c.local, message: 'is not an allowed element' }); continue; }
    if (p.name in out) { errors.push({ field: c.local, message: 'must not repeat' }); continue; }
    if (p.entity) out[p.name] = entityFromXml(p.entity, c, p.name);
    else {
      const v = scalarIn(p.type, c.text, p.name, errors);
      if (v !== undefined) out[p.name] = v;
    }
  }
  for (const p of params) if (p.required && !(p.name in out)) errors.push({ field: p.name, message: 'is required' });
  if (errors.length) throw new HttpError(400, `Invalid ${el.local} request`, { errors, code: 'invalid-request' });
  return out;
}

const notFound = (entity, id) => new HttpError(404, `${entity} ${id} not found`, { code: 'not-found' });

async function loadOne(ctx, entity, id) {
  const doc = await ctx.resources.get(ENTITIES[entity].resource, id);
  if (!doc) throw notFound(entity, id);
  return doc;
}

async function renderOne(ctx, entity, doc) {
  const [out] = await ctx.resources.render(ENTITIES[entity].resource, [doc]);
  return entityXml(entity, out);
}

// ---------------------------------------------------------------- operations
function buildOperations(def) {
  const E = def.entity;
  const el = ENTITIES[E].element;
  const R = def.related;
  const rEl = ENTITIES[R.entity].element;
  const idParam = { name: 'id', type: 'int', required: true };
  const listParams = [
    { name: 'page', type: 'int' }, { name: 'pageSize', type: 'int' }, { name: 'q', type: 'string' }, { name: 'sort', type: 'string' },
    ...def.filters,
  ];

  const ops = [
    {
      name: `Get${E}`, doc: `Get one ${el} by id.`,
      sample: '<tns:id>1</tns:id>',
      input: [idParam],
      output: [{ name: el, type: `tns:${E}` }],
      async run(ctx, p) { return renderOne(ctx, E, await loadOne(ctx, E, p.id)); },
    },
    {
      name: `List${def.plural}`, doc: `Page through ${def.listElement}. page starts at 1; pageSize 1-${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}); q = text search; sort = comma list of fields, "-" for descending; plus equality filters.`,
      sample: '<tns:page>1</tns:page><tns:pageSize>5</tns:pageSize>',
      input: listParams,
      output: [
        { name: 'page', type: 'xsd:int' }, { name: 'pageSize', type: 'xsd:int' }, { name: 'totalItems', type: 'xsd:int' }, { name: 'totalPages', type: 'xsd:int' },
        { name: def.listElement, list: el, type: `tns:${E}` },
      ],
      async run(ctx, p) {
        const page = p.page ?? 1;
        const pageSize = p.pageSize ?? DEFAULT_PAGE_SIZE;
        if (page < 1 || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
          throw new HttpError(400, `page must be >= 1 and pageSize between 1 and ${MAX_PAGE_SIZE}`, { code: 'invalid-paging' });
        }
        const name = ENTITIES[E].resource;
        const query = {};
        if (p.q) query.q = p.q;
        if (p.sort) query.sort = p.sort;
        for (const f of def.filters) if (p[f.name] !== undefined) query[f.name] = String(p[f.name]);
        const items = applyQuery(await ctx.resources.render(name, await ctx.resources.all(name)), query, { parseDate: ctx.dates.parseValue });
        const total = items.length;
        const slice = items.slice((page - 1) * pageSize, page * pageSize);
        return `<tns:page>${page}</tns:page><tns:pageSize>${pageSize}</tns:pageSize><tns:totalItems>${total}</tns:totalItems>`
          + `<tns:totalPages>${Math.ceil(total / pageSize)}</tns:totalPages>`
          + `<tns:${def.listElement}>${slice.map((d) => entityXml(E, d)).join('')}</tns:${def.listElement}>`;
      },
    },
    {
      name: `Create${E}`, doc: `Create one ${el}. Same validation as POST /v1/${ENTITIES[E].resource}.`,
      sample: `<tns:${el}>${def.createSample}</tns:${el}>`,
      input: [{ name: el, entity: E, type: `tns:${E}Input`, required: true }],
      output: [{ name: el, type: `tns:${E}` }],
      async run(ctx, p) { return renderOne(ctx, E, await ctx.resources.create(ENTITIES[E].resource, p[el])); },
    },
    {
      name: `Update${E}`, doc: `Update one ${el}: only the elements you send change (like a JSON merge patch).`,
      sample: `<tns:id>1</tns:id><tns:${el}>${def.updateSample}</tns:${el}>`,
      input: [idParam, { name: el, entity: E, type: `tns:${E}Update`, required: true }],
      output: [{ name: el, type: `tns:${E}` }],
      async run(ctx, p) {
        const existing = await loadOne(ctx, E, p.id);
        return renderOne(ctx, E, await ctx.resources.patch(ENTITIES[E].resource, existing, p[el]));
      },
    },
    {
      name: `Delete${E}`, doc: `Delete one ${el}.`,
      sample: '<tns:id>1</tns:id>',
      input: [idParam],
      output: [{ name: 'id', type: 'xsd:int' }, { name: 'deleted', type: 'xsd:boolean' }],
      async run(ctx, p) {
        await ctx.resources.remove(ENTITIES[E].resource, await loadOne(ctx, E, p.id));
        return `<tns:id>${p.id}</tns:id><tns:deleted>true</tns:deleted>`;
      },
    },
    {
      name: `Get${R.entity}`, doc: `Get one ${rEl} by id.`,
      sample: '<tns:id>1</tns:id>',
      input: [idParam],
      output: [{ name: rEl, type: `tns:${R.entity}` }],
      async run(ctx, p) { return entityXml(R.entity, await loadOne(ctx, R.entity, p.id)); },
    },
    {
      name: `List${R.plural}`, doc: `Every ${rEl}.`,
      sample: '',
      input: [],
      output: [{ name: R.listElement, list: rEl, type: `tns:${R.entity}` }],
      async run(ctx) {
        const all = await ctx.resources.all(ENTITIES[R.entity].resource);
        return `<tns:${R.listElement}>${all.map((d) => entityXml(R.entity, d)).join('')}</tns:${R.listElement}>`;
      },
    },
  ];
  for (const op of ops) {
    op.input = op.input.map((p) => ({ ...p, xsdType: p.entity ? p.type : XSD[p.type] }));
  }
  return ops;
}

const SERVICES = Object.fromEntries(Object.entries(SERVICE_DEFS).map(([name, def]) => {
  const operations = buildOperations(def);
  return [name, {
    name, ...def,
    ns: `${NS_BASE}${name}`,
    entities: [def.entity, def.related.entity],
    operations,
    byName: new Map(operations.map((o) => [o.name, o])),
    action: (op) => `${NS_BASE}${name}/${op}`,
  }];
}));

module.exports = { SERVICES, readParams, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE };
