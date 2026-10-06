'use strict';
// Response validation with Ajv (draft 2020-12). OAS 3.0 quirks (nullable, boolean exclusiveMinimum) are normalized first.
// "Lenient allOf" flattens allOf compositions so additionalProperties:false in one member doesn't reject the others' fields.
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { get, deref, escape } = require('./refs');

function clone(x) { return JSON.parse(JSON.stringify(x)); }

// OAS 3.0 -> JSON Schema 2020-12 normalization (in place).
function normalize30(node) {
  if (Array.isArray(node)) { node.forEach(normalize30); return; }
  if (!node || typeof node !== 'object') return;
  if (node.nullable === true) {
    if (node.$ref) {
      const r = node.$ref;
      delete node.$ref;
      node.anyOf = [{ $ref: r }, { type: 'null' }];
    } else if (node.type && !Array.isArray(node.type)) node.type = [node.type, 'null'];
    else if (Array.isArray(node.type) && !node.type.includes('null')) node.type.push('null');
    if (Array.isArray(node.enum) && !node.enum.includes(null)) node.enum.push(null);
  }
  if ('nullable' in node && typeof node.nullable === 'boolean') delete node.nullable;
  if (typeof node.exclusiveMinimum === 'boolean') {
    if (node.exclusiveMinimum && node.minimum !== undefined) { node.exclusiveMinimum = node.minimum; delete node.minimum; } else delete node.exclusiveMinimum;
  }
  if (typeof node.exclusiveMaximum === 'boolean') {
    if (node.exclusiveMaximum && node.maximum !== undefined) { node.exclusiveMaximum = node.maximum; delete node.maximum; } else delete node.exclusiveMaximum;
  }
  // 3.0 ignores siblings of $ref; JSON Schema 2020 doesn't. Keep them, they are usually descriptive only.
  for (const v of Object.values(node)) normalize30(v);
}

// Flatten allOf (resolving $refs) into one object schema per composition (in place).
function flattenAllOf(doc, node, seen = new Set()) {
  if (Array.isArray(node)) { node.forEach((n) => flattenAllOf(doc, n, seen)); return; }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.allOf)) {
    const merged = { properties: {}, required: [] };
    let closed = false;
    const visit = (part, depth) => {
      const p = part && part.$ref ? deref(doc, part) : part;
      if (!p || typeof p !== 'object' || depth > 10) return;
      if (Array.isArray(p.allOf)) p.allOf.forEach((x) => visit(x, depth + 1));
      if (p.type && !merged.type) merged.type = p.type;
      Object.assign(merged.properties, p.properties || {});
      merged.required.push(...(p.required || []));
      if (p.additionalProperties === false || p.unevaluatedProperties === false) closed = true;
      for (const k of ['description', 'title', 'format', 'pattern', 'enum', 'items', 'minProperties', 'maxProperties']) {
        if (p[k] !== undefined && merged[k] === undefined) merged[k] = p[k];
      }
    };
    node.allOf.forEach((x) => visit(x, 0));
    delete node.allOf;
    node.type = node.type || merged.type || 'object';
    node.properties = { ...merged.properties, ...(node.properties || {}) };
    node.required = [...new Set([...merged.required, ...(node.required || [])])];
    if (!node.required.length) delete node.required;
    for (const k of ['description', 'title', 'format', 'pattern', 'enum', 'items', 'minProperties', 'maxProperties']) {
      if (merged[k] !== undefined && node[k] === undefined) node[k] = merged[k];
    }
    if (closed && node.additionalProperties === undefined) node.additionalProperties = false;
  }
  for (const v of Object.values(node)) flattenAllOf(doc, v, seen);
}

function makeAjv() {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true, logger: false, discriminator: false });
  addFormats(ajv);
  ajv.addFormat('int32', { type: 'number', validate: (n) => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 });
  ajv.addFormat('int64', { type: 'number', validate: (n) => Number.isInteger(n) });
  ajv.addFormat('float', { type: 'number', validate: () => true });
  ajv.addFormat('double', { type: 'number', validate: () => true });
  for (const f of ['byte', 'binary', 'password', 'decimal', 'currency', 'html', 'markdown']) ajv.addFormat(f, true);
  ajv.addKeyword({ keyword: 'example' });
  ajv.addKeyword({ keyword: 'xml' });
  ajv.addKeyword({ keyword: 'externalDocs' });
  ajv.addKeyword({ keyword: 'discriminator' });
  return ajv;
}

function plain(e, data) {
  const where = e.instancePath || '(root)';
  switch (e.keyword) {
    case 'required': return `${where}: missing required property "${e.params.missingProperty}"`;
    case 'additionalProperties': return `${where}: property "${e.params.additionalProperty}" is not allowed (additionalProperties: false)`;
    case 'unevaluatedProperties': return `${where}: property "${e.params.unevaluatedProperty}" is not allowed (unevaluatedProperties: false)`;
    case 'type': {
      const actual = valueAt(data, e.instancePath);
      return `${where}: expected ${e.params.type}, got ${actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual}`;
    }
    case 'enum': return `${where}: must be one of ${e.params.allowedValues.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'const': return `${where}: must equal ${JSON.stringify(e.params.allowedValue)}`;
    case 'pattern': return `${where}: "${valueAt(data, e.instancePath)}" does not match pattern ${e.params.pattern}`;
    case 'format': return `${where}: "${valueAt(data, e.instancePath)}" is not a valid ${e.params.format}`;
    default: return `${where}: ${e.message}`;
  }
}

function valueAt(data, pointer) {
  if (!pointer) return data;
  let cur = data;
  for (const p of pointer.split('/').slice(1)) {
    if (cur == null) return undefined;
    cur = cur[p.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

class SpecValidator {
  constructor(doc, { version = '3.1', lenientAllOf = false } = {}) {
    this.original = doc;
    const prepared = clone(doc);
    if (version === '3.0') normalize30(prepared);
    if (lenientAllOf) flattenAllOf(prepared, prepared);
    delete prepared.$schema;
    delete prepared.$id;
    this.doc = prepared;
    this.ajv = makeAjv();
    // The whole document is registered as one schema so local $refs (#/components/...) resolve; it is not
    // itself validated against the JSON Schema meta-schema (it is an OpenAPI document, not a schema).
    this.ajv.addSchema({ ...prepared, $id: 'urn:oas:spec' }, undefined, undefined, false);
    this.cache = new Map();
  }

  validator(pointer) {
    if (!this.cache.has(pointer)) {
      this.cache.set(pointer, this.ajv.compile({ $ref: `urn:oas:spec#${pointer.replace(/^#/, '')}` }));
    }
    return this.cache.get(pointer);
  }

  // Validate data against the schema at pointer. Returns [] when valid.
  validate(pointer, data) {
    let fn;
    try {
      fn = this.validator(pointer);
    } catch (e) {
      return [{ pointer: '', schemaPath: pointer, keyword: 'compile', message: `Schema could not be compiled: ${e.message}` }];
    }
    if (fn(data)) return [];
    const errs = (fn.errors || []).map((e) => ({
      pointer: e.instancePath || '',
      schemaPath: e.schemaPath,
      keyword: e.keyword,
      params: e.params,
      message: plain(e, data),
      hint: e.keyword === 'additionalProperties' && /\/allOf\//.test(e.schemaPath)
        ? 'allOf member has additionalProperties:false, so fields from the other members are rejected. See Spec lint (allOf trap) or enable "lenient allOf".'
        : undefined,
    }));
    // De-duplicate identical messages.
    const seen = new Set();
    return errs.filter((e) => (seen.has(e.message) ? false : seen.add(e.message)));
  }

  schemaAt(pointer) { return get(this.doc, pointer); }
}

module.exports = { SpecValidator, normalize30, flattenAllOf, escape };
