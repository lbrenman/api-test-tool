'use strict';
// Sample data from OpenAPI schemas. Priority: examples -> example -> default -> enum/const -> generated
// (honoring pattern, format, min/max, required, nullable / type: [x, 'null']).
const crypto = require('node:crypto');
const RandExp = require('randexp');
const { deref } = require('./refs');

function firstExample(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.example !== undefined) return schema.example;
  return undefined;
}

function pickType(schema) {
  let t = schema.type;
  if (Array.isArray(t)) t = t.find((x) => x !== 'null') || 'null';
  if (!t) {
    if (schema.properties || schema.additionalProperties || schema.required) t = 'object';
    else if (schema.items) t = 'array';
    else if (schema.pattern || schema.format || schema.minLength !== undefined) t = 'string';
    else if (schema.minimum !== undefined || schema.maximum !== undefined) t = 'number';
  }
  return t;
}

function fromPattern(pattern, minLength, maxLength) {
  try {
    const re = new RegExp(pattern);
    const gen = new RandExp(pattern);
    gen.max = 6;
    for (let i = 0; i < 25; i++) {
      const s = gen.gen();
      if (re.test(s) && (minLength === undefined || s.length >= minLength) && (maxLength === undefined || s.length <= maxLength)) return s;
    }
    return gen.gen();
  } catch {
    return 'string';
  }
}

const NAME_HINTS = [
  [/e-?mail/i, () => 'jane.doe@example.com'],
  [/phone/i, () => '+1-555-0100'],
  [/url|uri|href|link/i, () => 'https://example.com/resource'],
  [/country.?code/i, () => 'US'],
  [/currency/i, () => 'USD'],
  [/first.?name/i, () => 'Jane'],
  [/last.?name/i, () => 'Doe'],
  [/^name$|.name$/i, () => 'Sample name'],
  [/city/i, () => 'Springfield'],
  [/postal|zip/i, () => '02134'],
  [/description|comment|note/i, () => 'Sample description'],
];

function stringValue(schema, key) {
  const { format, pattern, minLength, maxLength } = schema;
  let s;
  if (pattern) return fromPattern(pattern, minLength, maxLength);
  switch (format) {
    case 'date-time': s = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); break;
    case 'date': s = new Date().toISOString().slice(0, 10); break;
    case 'time': s = '14:30:00Z'; break;
    case 'email': case 'idn-email': s = 'jane.doe@example.com'; break;
    case 'uri': case 'url': case 'iri': s = 'https://example.com/resource'; break;
    case 'uri-reference': case 'iri-reference': s = '/resource/1'; break;
    case 'uuid': s = crypto.randomUUID(); break;
    case 'hostname': case 'idn-hostname': s = 'example.com'; break;
    case 'ipv4': s = '192.0.2.10'; break;
    case 'ipv6': s = '2001:db8::10'; break;
    case 'byte': s = Buffer.from('hello').toString('base64'); break;
    case 'binary': s = ''; break;
    case 'password': s = 'P@ssw0rd!'; break;
    case 'duration': s = 'PT15M'; break;
    case 'int64': case 'int32': s = '1'; break;
    default: {
      const hint = key && NAME_HINTS.find(([re]) => re.test(key));
      s = hint ? hint[1]() : 'string';
    }
  }
  if (minLength !== undefined && s.length < minLength) s = s.padEnd(minLength, 'x');
  if (maxLength !== undefined && s.length > maxLength) s = s.slice(0, maxLength);
  return s;
}

function numberValue(schema, isInt) {
  let min = schema.minimum;
  let max = schema.maximum;
  if (typeof schema.exclusiveMinimum === 'number') min = schema.exclusiveMinimum + (isInt ? 1 : 0.5);
  else if (schema.exclusiveMinimum === true && min !== undefined) min += isInt ? 1 : 0.5;
  if (typeof schema.exclusiveMaximum === 'number') max = schema.exclusiveMaximum - (isInt ? 1 : 0.5);
  else if (schema.exclusiveMaximum === true && max !== undefined) max -= isInt ? 1 : 0.5;
  let v = min !== undefined ? min : max !== undefined ? Math.min(max, isInt ? 1 : 1.5) : isInt ? 1 : 1.5;
  if (min !== undefined && max !== undefined && max > min) v = isInt ? Math.ceil(min) : min;
  if (max !== undefined && v > max) v = max;
  if (schema.multipleOf) v = Math.ceil(v / schema.multipleOf) * schema.multipleOf;
  return isInt ? Math.round(v) : v;
}

function mergeAllOf(doc, schema) {
  const out = { ...schema };
  delete out.allOf;
  for (const part of schema.allOf) {
    const p = deref(doc, part) || {};
    const merged = p.allOf ? mergeAllOf(doc, p) : p;
    out.type = out.type || merged.type;
    out.properties = { ...(out.properties || {}), ...(merged.properties || {}) };
    out.required = [...new Set([...(out.required || []), ...(merged.required || [])])];
    for (const k of ['example', 'examples', 'items', 'enum', 'format', 'pattern']) if (out[k] === undefined && merged[k] !== undefined) out[k] = merged[k];
  }
  return out;
}

// mode: 'request' skips readOnly properties, 'response' skips writeOnly.
function sample(doc, schemaIn, { mode = 'request', depth = 0, key, seen = new Set(), useExamples = true } = {}) {
  if (!schemaIn || typeof schemaIn !== 'object') return null;
  let schema = schemaIn;
  if (schema.$ref) {
    if (seen.has(schema.$ref) && depth > 2) return null;
    seen = new Set(seen).add(schema.$ref);
    schema = deref(doc, schema) || {};
  }
  if (useExamples) {
    const ex = firstExample(schema);
    if (ex !== undefined) return JSON.parse(JSON.stringify(ex));
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((v) => v !== null) ?? schema.enum[0];
  if (schema.allOf) return sample(doc, mergeAllOf(doc, schema), { mode, depth, key, seen, useExamples });
  if (schema.oneOf || schema.anyOf) {
    const opts = (schema.oneOf || schema.anyOf).filter((o) => deref(doc, o)?.type !== 'null');
    return sample(doc, opts[0] || {}, { mode, depth: depth + 1, key, seen, useExamples });
  }
  const t = pickType(schema);
  if (depth > 8) return t === 'array' ? [] : t === 'object' ? {} : null;
  switch (t) {
    case 'null': return null;
    case 'boolean': return true;
    case 'integer': return numberValue(schema, true);
    case 'number': return numberValue(schema, false);
    case 'string': return stringValue(schema, key);
    case 'array': {
      const n = Math.max(1, schema.minItems || 0);
      const out = [];
      const itemSchema = schema.items && typeof schema.items === 'object' ? schema.items : {};
      const resolvedItem = deref(doc, itemSchema) || {};
      for (let i = 0; i < n; i++) {
        let v = sample(doc, itemSchema, { mode, depth: depth + 1, key, seen, useExamples });
        if (schema.uniqueItems && Array.isArray(resolvedItem.enum) && resolvedItem.enum[i] !== undefined) v = resolvedItem.enum[i];
        out.push(v);
      }
      return out;
    }
    case 'object':
    default: {
      const out = {};
      const props = schema.properties || {};
      const required = new Set(schema.required || []);
      for (const [k, ps] of Object.entries(props)) {
        const p = deref(doc, ps) || {};
        if (mode === 'request' && p.readOnly && !required.has(k)) continue;
        if (mode === 'response' && p.writeOnly) continue;
        out[k] = sample(doc, ps, { mode, depth: depth + 1, key: k, seen, useExamples });
      }
      for (const r of required) if (!(r in out)) out[r] = 'string';
      return out;
    }
  }
}

// Example value for a parameter object.
function paramSample(doc, param) {
  if (param.example !== undefined) return param.example;
  if (param.examples && typeof param.examples === 'object') {
    const first = Object.values(param.examples)[0];
    const ex = deref(doc, first);
    if (ex && ex.value !== undefined) return ex.value;
  }
  return sample(doc, param.schema || { type: 'string' }, { key: param.name });
}

// Named examples for a media type object: [{ name, summary, value }].
function mediaExamples(doc, media) {
  const out = [];
  if (!media) return out;
  if (media.examples && typeof media.examples === 'object') {
    for (const [name, exRef] of Object.entries(media.examples)) {
      const ex = deref(doc, exRef);
      if (ex && ex.value !== undefined) out.push({ name, summary: ex.summary || '', value: ex.value });
    }
  }
  if (media.example !== undefined) out.push({ name: 'example', summary: 'media example', value: media.example });
  const schemaEx = firstExample(deref(doc, media.schema));
  if (schemaEx !== undefined) out.push({ name: 'schema-example', summary: 'schema example', value: schemaEx });
  return out;
}

function mediaSample(doc, media, mode = 'request') {
  const named = mediaExamples(doc, media);
  if (named.length) return { value: JSON.parse(JSON.stringify(named[0].value)), source: named[0].name };
  return { value: sample(doc, media?.schema || {}, { mode }), source: 'generated' };
}

module.exports = { sample, paramSample, mediaExamples, mediaSample, fromPattern };
