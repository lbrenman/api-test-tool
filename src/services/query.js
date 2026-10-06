'use strict';
// Filtering (?field=value, ?field[op]=value, ?q=text), sorting (?sort=-a,b) and sparse fieldsets (?fields=a,b.c).
const { HttpError } = require('../util/problem');
const { TIMESTAMP_FIELDS } = require('./dateFormat');

const RESERVED = new Set([
  'offset', 'limit', 'page', 'size', 'per_page', 'cursor', 'after_id', 'before_id',
  'pageToken', 'pageSize', 'sort', 'fields', 'q', 'inline', 'api_key', 'access_token',
]);
const OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'like', 'exists']);

function getPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function hasPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

function coerceLike(sample, raw, field, parseDate) {
  const last = field.split('.').pop();
  if (TIMESTAMP_FIELDS.has(last) && parseDate) {
    try { return parseDate(raw); } catch { throw new HttpError(400, `Invalid timestamp for filter ${field}: ${raw}`); }
  }
  if (raw === 'null') return null;
  if (typeof sample === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new HttpError(400, `Filter ${field} expects a number, got "${raw}"`);
    return n;
  }
  if (typeof sample === 'boolean') {
    if (!['true', 'false'].includes(String(raw).toLowerCase())) throw new HttpError(400, `Filter ${field} expects true or false`);
    return String(raw).toLowerCase() === 'true';
  }
  return String(raw);
}

function eq(a, b) {
  if (Array.isArray(a)) return a.some((x) => eq(x, b));
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function cmp(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function deepText(v, out = []) {
  if (v === null || v === undefined) return out;
  if (typeof v === 'object') { for (const x of Object.values(v)) deepText(x, out); return out; }
  out.push(String(v));
  return out;
}

// Build a predicate list from req.query.
function buildFilters(query, sampleDoc, parseDate, ignore = []) {
  const filters = [];
  for (const [key, val] of Object.entries(query || {})) {
    if (RESERVED.has(key) || key.startsWith('_') || ignore.includes(key)) continue;
    if (sampleDoc && !hasPath(sampleDoc, key)) {
      throw new HttpError(400, `Unknown filter field "${key}"`, {
        errors: [{ field: key, message: 'Not a field of this resource' }],
      });
    }
    const sample = sampleDoc ? getPath(sampleDoc, key) : undefined;
    const sampleScalar = Array.isArray(sample) ? sample[0] : sample;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [op, raw] of Object.entries(val)) {
        if (!OPS.has(op)) throw new HttpError(400, `Unknown filter operator "${op}" on ${key}`);
        filters.push(makeOp(key, op, raw, sampleScalar, parseDate));
      }
    } else {
      const raw = Array.isArray(val) ? val.join(',') : String(val);
      const parts = raw.split(',');
      if (parts.length > 1) filters.push(makeOp(key, 'in', raw, sampleScalar, parseDate));
      else filters.push(makeOp(key, 'eq', raw, sampleScalar, parseDate));
    }
  }
  if (query && query.q) {
    const needle = String(query.q).toLowerCase();
    filters.push((doc) => deepText(doc).some((t) => t.toLowerCase().includes(needle)));
  }
  return filters;
}

function makeOp(key, op, raw, sample, parseDate) {
  const list = () => String(raw).split(',').map((r) => coerceLike(sample, r.trim(), key, parseDate));
  switch (op) {
    case 'eq': { const v = coerceLike(sample, raw, key, parseDate); return (d) => eq(getPath(d, key), v); }
    case 'ne': { const v = coerceLike(sample, raw, key, parseDate); return (d) => !eq(getPath(d, key), v); }
    case 'in': { const vs = list(); return (d) => vs.some((v) => eq(getPath(d, key), v)); }
    case 'nin': { const vs = list(); return (d) => !vs.some((v) => eq(getPath(d, key), v)); }
    case 'gt': { const v = coerceLike(sample, raw, key, parseDate); return (d) => getPath(d, key) != null && cmp(getPath(d, key), v) > 0; }
    case 'gte': { const v = coerceLike(sample, raw, key, parseDate); return (d) => getPath(d, key) != null && cmp(getPath(d, key), v) >= 0; }
    case 'lt': { const v = coerceLike(sample, raw, key, parseDate); return (d) => getPath(d, key) != null && cmp(getPath(d, key), v) < 0; }
    case 'lte': { const v = coerceLike(sample, raw, key, parseDate); return (d) => getPath(d, key) != null && cmp(getPath(d, key), v) <= 0; }
    case 'like': { const n = String(raw).toLowerCase(); return (d) => deepText(getPath(d, key)).some((t) => t.toLowerCase().includes(n)); }
    case 'exists': { const want = String(raw) !== 'false'; return (d) => (getPath(d, key) !== null && getPath(d, key) !== undefined) === want; }
    default: throw new HttpError(400, `Unknown operator ${op}`);
  }
}

function parseSort(sort, sampleDoc) {
  if (!sort) return [];
  return String(sort).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const desc = s.startsWith('-');
    const field = s.replace(/^[-+]/, '');
    if (sampleDoc && !hasPath(sampleDoc, field)) throw new HttpError(400, `Unknown sort field "${field}"`);
    return { field, desc };
  });
}

function applyQuery(items, query, { parseDate, ignore } = {}) {
  const sample = items[0];
  const filters = buildFilters(query, sample, parseDate, ignore);
  let out = filters.length ? items.filter((d) => filters.every((f) => f(d))) : items.slice();
  const sorts = parseSort(query && query.sort, sample);
  if (sorts.length) {
    out.sort((a, b) => {
      for (const { field, desc } of sorts) {
        const c = cmp(getPath(a, field), getPath(b, field));
        if (c !== 0) return desc ? -c : c;
      }
      return 0;
    });
  }
  return out;
}

function parseFields(fields) {
  if (!fields) return null;
  const list = String(fields).split(',').map((f) => f.trim()).filter(Boolean);
  return list.length ? list : null;
}

function project(doc, fields) {
  if (!fields) return doc;
  const out = {};
  for (const f of fields) {
    const v = getPath(doc, f);
    if (v === undefined) continue;
    const parts = f.split('.');
    let cur = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) cur[p] = v;
      else { cur[p] = cur[p] && typeof cur[p] === 'object' ? cur[p] : {}; cur = cur[p]; }
    });
  }
  return out;
}

module.exports = { applyQuery, parseFields, project, getPath, RESERVED };
