'use strict';
// SOAP view of the mock data. One field table per entity drives three things so they never drift:
//   - the XSD inside the WSDL
//   - JSON document -> XML (responses)
//   - XML -> JSON input (Create/Update requests), which then goes through the same validation as /v1
//
// Field: { name, type, nillable?, ro?, list?, item?, fields?, enum?, out? }
//   type: string | int | decimal | double | boolean | date | dateTime | complex
//   list: true  -> wrapper element <name> containing repeated <item> elements
//   ro:   true  -> output only (ignored / rejected on input)
//   out:  (doc) => value  -> custom output value
// Timestamps are always xsd:dateTime in UTC here: DATE_FORMAT only applies to the JSON /v1 API.
const { HttpError } = require('../../util/problem');
const { INPUT, LEVELS, PHONE_TYPES, CURRENCIES, DIM_UNITS, SIZES } = require('../../services/schemas');
const { escapeXml, elements, textOf, isNil } = require('./xml');

const money = (decimalField, numberField) => (d) => d[decimalField] ?? (d[numberField] == null ? undefined : Number(d[numberField]).toFixed(2));

const ADDRESS = [
  { name: 'street', type: 'string' }, { name: 'city', type: 'string' }, { name: 'region', type: 'string' },
  { name: 'postalCode', type: 'string' }, { name: 'countryCode', type: 'string' },
  { name: 'geo', type: 'complex', typeName: 'GeoPoint', fields: [{ name: 'lat', type: 'double' }, { name: 'lng', type: 'double' }] },
];

const REF = [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }, { name: 'code', type: 'string' }];

const ENTITIES = {
  Employee: {
    resource: 'employees',
    element: 'employee',
    fields: [
      { name: 'id', type: 'int', ro: true },
      { name: 'uuid', type: 'string', ro: true },
      { name: 'employeeNumber', type: 'string' },
      { name: 'firstName', type: 'string' },
      { name: 'lastName', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'level', type: 'string', enum: LEVELS, enumName: 'Level' },
      { name: 'isActive', type: 'boolean' },
      { name: 'salary', type: 'decimal', out: money('salaryDecimal', 'salary') },
      { name: 'performanceRating', type: 'double', nillable: true },
      { name: 'departmentId', type: 'int' },
      { name: 'department', type: 'complex', typeName: 'DepartmentRef', ro: true, fields: REF },
      { name: 'managerId', type: 'int', nillable: true },
      { name: 'skills', type: 'string', list: true, item: 'skill' },
      {
        name: 'certifications', type: 'complex', typeName: 'Certification', list: true, item: 'certification',
        fields: [{ name: 'name', type: 'string' }, { name: 'issuedAt', type: 'dateTime' }, { name: 'expiresAt', type: 'dateTime', nillable: true }],
      },
      { name: 'address', type: 'complex', typeName: 'Address', fields: ADDRESS },
      {
        name: 'phoneNumbers', type: 'complex', typeName: 'PhoneNumber', list: true, item: 'phoneNumber',
        fields: [{ name: 'type', type: 'string', enum: PHONE_TYPES, enumName: 'PhoneType' }, { name: 'number', type: 'string' }],
      },
      { name: 'hireDate', type: 'date' },
      { name: 'createdAt', type: 'dateTime', ro: true },
      { name: 'updatedAt', type: 'dateTime', ro: true },
    ],
  },
  Product: {
    resource: 'products',
    element: 'product',
    fields: [
      { name: 'id', type: 'int', ro: true },
      { name: 'uuid', type: 'string', ro: true },
      { name: 'sku', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'price', type: 'decimal', out: money('priceDecimal', 'price') },
      { name: 'currency', type: 'string', enum: CURRENCIES, enumName: 'Currency' },
      { name: 'inStock', type: 'boolean' },
      { name: 'stockQty', type: 'int' },
      { name: 'weightKg', type: 'double' },
      {
        name: 'dimensions', type: 'complex', typeName: 'Dimensions',
        fields: [{ name: 'l', type: 'double' }, { name: 'w', type: 'double' }, { name: 'h', type: 'double' }, { name: 'unit', type: 'string', enum: DIM_UNITS, enumName: 'DimensionUnit' }],
      },
      { name: 'tags', type: 'string', list: true, item: 'tag' },
      {
        name: 'variants', type: 'complex', typeName: 'Variant', list: true, item: 'variant',
        fields: [{ name: 'sku', type: 'string' }, { name: 'color', type: 'string' }, { name: 'size', type: 'string', enum: SIZES, enumName: 'Size' }, { name: 'priceDelta', type: 'double' }],
      },
      { name: 'categoryId', type: 'int' },
      { name: 'category', type: 'complex', typeName: 'CategoryRef', ro: true, fields: REF },
      { name: 'rating', type: 'double', nillable: true },
      { name: 'releaseDate', type: 'date' },
      { name: 'discontinuedAt', type: 'dateTime', nillable: true },
      { name: 'createdAt', type: 'dateTime', ro: true },
      { name: 'updatedAt', type: 'dateTime', ro: true },
    ],
  },
  Department: {
    resource: 'departments',
    element: 'department',
    fields: [
      { name: 'id', type: 'int', ro: true }, { name: 'name', type: 'string' }, { name: 'code', type: 'string' },
      { name: 'createdAt', type: 'dateTime', ro: true }, { name: 'updatedAt', type: 'dateTime', ro: true },
    ],
  },
  Category: {
    resource: 'categories',
    element: 'category',
    fields: [
      { name: 'id', type: 'int', ro: true }, { name: 'name', type: 'string' }, { name: 'code', type: 'string' },
      { name: 'createdAt', type: 'dateTime', ro: true }, { name: 'updatedAt', type: 'dateTime', ro: true },
    ],
  },
};

const XSD_TYPE = { string: 'xsd:string', int: 'xsd:int', decimal: 'xsd:decimal', double: 'xsd:double', boolean: 'xsd:boolean', date: 'xsd:date', dateTime: 'xsd:dateTime' };

// ---------------------------------------------------------------- JSON -> XML
function scalarOut(type, v) {
  if (type === 'boolean') return v ? 'true' : 'false';
  if (type === 'dateTime') {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : String(v);
  }
  return String(v);
}

function fieldXml(f, value, p) {
  const tag = `${p}${f.name}`;
  if (value === undefined) return '';
  if (value === null) return f.nillable ? `<${tag} xsi:nil="true"/>` : '';
  if (f.list) {
    const items = Array.isArray(value) ? value : [];
    const inner = items.map((it) => (f.type === 'complex'
      ? `<${p}${f.item}>${fieldsXml(f.fields, it, p)}</${p}${f.item}>`
      : `<${p}${f.item}>${escapeXml(scalarOut(f.type, it))}</${p}${f.item}>`)).join('');
    return `<${tag}>${inner}</${tag}>`;
  }
  if (f.type === 'complex') return typeof value === 'object' ? `<${tag}>${fieldsXml(f.fields, value, p)}</${tag}>` : '';
  return `<${tag}>${escapeXml(scalarOut(f.type, value))}</${tag}>`;
}

function fieldsXml(fields, doc, p) {
  return fields.map((f) => fieldXml(f, f.out ? f.out(doc) : doc?.[f.name], p)).join('');
}

/** <tns:employee>…</tns:employee> for one document. */
function entityXml(entityName, doc, p = 'tns:', element) {
  const e = ENTITIES[entityName];
  const tag = `${p}${element || e.element}`;
  return `<${tag}>${fieldsXml(e.fields, doc, p)}</${tag}>`;
}

// ---------------------------------------------------------------- XML -> JSON
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DEC = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function scalarIn(type, raw, path, errors) {
  const s = raw.trim();
  switch (type) {
    case 'int':
      if (!/^[+-]?\d+$/.test(s)) { errors.push({ field: path, message: 'must be an xsd:int' }); return undefined; }
      return Number(s);
    case 'decimal':
      if (!DEC.test(s)) { errors.push({ field: path, message: 'must be an xsd:decimal' }); return undefined; }
      return Number(s);
    case 'double':
      if (!NUM.test(s)) { errors.push({ field: path, message: 'must be an xsd:double' }); return undefined; }
      return Number(s);
    case 'boolean':
      if (['true', '1'].includes(s)) return true;
      if (['false', '0'].includes(s)) return false;
      errors.push({ field: path, message: 'must be an xsd:boolean (true, false, 1 or 0)' });
      return undefined;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) { errors.push({ field: path, message: 'must be an xsd:date (YYYY-MM-DD)' }); return undefined; }
      return s;
    default:
      return type === 'string' ? raw : s; // strings keep their whitespace
  }
}

function readFields(fields, el, path, errors) {
  const out = {};
  const byName = new Map(fields.map((f) => [f.name, f]));
  const seen = new Set();
  for (const c of elements(el)) {
    const f = byName.get(c.local);
    const p = path ? `${path}.${c.local}` : c.local;
    if (!f || f.ro) { errors.push({ field: p, message: f ? 'is read-only' : 'is not an allowed element' }); continue; }
    if (seen.has(f.name)) { errors.push({ field: p, message: 'must not repeat' }); continue; }
    seen.add(f.name);
    if (isNil(c)) {
      if (f.nillable) out[f.name] = null;
      else errors.push({ field: p, message: 'is not nillable' });
      continue;
    }
    if (f.list) {
      out[f.name] = elements(c).map((it, i) => {
        const ip = `${p}.${i}`;
        if (it.local !== f.item) { errors.push({ field: ip, message: `must be a <${f.item}> element` }); return undefined; }
        return f.type === 'complex' ? readFields(f.fields, it, ip, errors) : scalarIn(f.type, it.text, ip, errors);
      });
    } else if (f.type === 'complex') {
      out[f.name] = readFields(f.fields, c, p, errors);
    } else {
      const v = scalarIn(f.type, c.text, p, errors);
      if (v !== undefined) out[f.name] = v;
    }
  }
  return out;
}

/** <employee>…</employee> request element -> JSON input for ResourceService. Throws 400 on type errors. */
function entityFromXml(entityName, el, path) {
  const errors = [];
  const out = readFields(ENTITIES[entityName].fields, el, path, errors);
  if (errors.length) throw new HttpError(400, `Invalid ${entityName} element`, { errors, code: 'invalid-element' });
  return out;
}

// ---------------------------------------------------------------- XSD
function xsdElement(f, mode, required, ind) {
  const min = mode === 'input' && required.includes(f.name) ? '1' : '0';
  const nil = f.nillable ? ' nillable="true"' : '';
  const base = (t) => (f.enum ? `tns:${enumTypeName(f)}` : XSD_TYPE[t]);
  if (f.list) {
    const itemType = f.type === 'complex' ? `tns:${f.typeName}` : base(f.type);
    return `${ind}<xsd:element name="${f.name}" minOccurs="${min}"${nil}>\n`
      + `${ind}  <xsd:complexType><xsd:sequence><xsd:element name="${f.item}" type="${itemType}" minOccurs="0" maxOccurs="unbounded"/></xsd:sequence></xsd:complexType>\n`
      + `${ind}</xsd:element>`;
  }
  const t = f.type === 'complex' ? `tns:${f.typeName}` : base(f.type);
  return `${ind}<xsd:element name="${f.name}" type="${t}" minOccurs="${min}"${nil}/>`;
}

const enumTypeName = (f) => f.enumName || `${f.name[0].toUpperCase()}${f.name.slice(1)}`;

function complexType(name, fields, mode, required = [], ind = '      ') {
  const els = fields.filter((f) => mode === 'output' || !f.ro).map((f) => xsdElement(f, mode, required, `${ind}    `)).join('\n');
  return `${ind}<xsd:complexType name="${name}">\n${ind}  <xsd:sequence>\n${els}\n${ind}  </xsd:sequence>\n${ind}</xsd:complexType>`;
}

// Nested complex types and enums used by an entity (each emitted once).
function supportingTypes(fields, seen, out, ind) {
  for (const f of fields) {
    if (f.enum) {
      const n = enumTypeName(f);
      if (!seen.has(n)) {
        seen.add(n);
        out.push(`${ind}<xsd:simpleType name="${n}"><xsd:restriction base="xsd:string">${f.enum.map((v) => `<xsd:enumeration value="${escapeXml(v)}"/>`).join('')}</xsd:restriction></xsd:simpleType>`);
      }
    }
    if (f.type === 'complex' && !seen.has(f.typeName)) {
      seen.add(f.typeName);
      supportingTypes(f.fields, seen, out, ind);
      out.push(complexType(f.typeName, f.fields, 'output', [], ind));
    }
  }
}

/** XSD types for an entity: <Name> (output), <Name>Input (create), <Name>Update (all optional). */
function entityXsd(entityName, seen, ind = '      ') {
  const e = ENTITIES[entityName];
  const out = [];
  supportingTypes(e.fields, seen, out, ind);
  const required = INPUT[e.resource]?.required || [];
  out.push(complexType(entityName, e.fields, 'output', [], ind));
  out.push(complexType(`${entityName}Input`, e.fields, 'input', required, ind));
  out.push(complexType(`${entityName}Update`, e.fields, 'input', [], ind));
  return out.join('\n');
}

module.exports = { ENTITIES, entityXml, entityFromXml, entityXsd, scalarIn };
