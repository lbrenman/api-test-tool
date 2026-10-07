'use strict';
// OData system query options: parsing ($select, $expand with nested options, $filter, $orderby,
// $top, $skip, $count, $search) and applying them to entities, plus entity serialization.
const { HttpError } = require('../../util/problem');
const { etagOf } = require('../../services/resources');
const { ENTITIES, SETS, member, shape, NS } = require('./model');
const { compileFilter, compileOrderBy, sortBy } = require('./expr');

const bad = (message) => new HttpError(400, message, { code: 'invalid-query-option' });

// Split on sep at nesting level 0, ignoring quoted strings.
function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'") quote = !quote;
    if (!quote) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (depth < 0) throw bad(`Unbalanced parentheses in "${str}"`);
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  if (depth !== 0 || quote) throw bad(`Unbalanced parentheses or quotes in "${str}"`);
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const nonNegInt = (v, name) => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(String(v))) throw bad(`${name} must be a non-negative integer, got "${v}"`);
  return Number(v);
};

function parseSelect(text, typeName) {
  if (text === undefined) return null;
  const items = splitTop(String(text), ',');
  if (!items.length) throw bad('$select is empty');
  const sel = [];
  for (const item of items) {
    if (item === '*') { sel.push('*'); continue; }
    const [head, sub, ...more] = item.split('/');
    if (more.length) throw bad(`$select paths can be one or two segments deep: "${item}"`);
    const m = member(typeName, head);
    if (!m) throw bad(`Could not find a property named '${head}' on type '${NS}.${typeName}'`);
    if (sub !== undefined) {
      if (m.kind !== 'prop' || m.prop.coll || m.prop.type.startsWith('Edm.') || !member(m.prop.type, sub)) throw bad(`Invalid $select path "${item}"`);
    }
    sel.push(sub === undefined ? head : `${head}/${sub}`);
  }
  return sel;
}

// options: { select, expand, filter, orderby, top, skip, count, search } (all optional)
function parseOptions(raw, typeName, { nested = false } = {}) {
  const known = ['$select', '$expand', '$filter', '$orderby', '$top', '$skip', '$count', '$search', ...(nested ? [] : ['$skiptoken', '$format'])];
  for (const k of Object.keys(raw)) {
    if (k.startsWith('$') && !known.includes(k)) {
      throw new HttpError(k === '$apply' || k === '$compute' || k === '$levels' ? 501 : 400, `The query option ${k} is not supported${nested ? ' inside $expand' : ''}`, { code: 'unsupported-query-option' });
    }
  }
  const o = {};
  o.select = parseSelect(raw.$select, typeName);
  o.filter = raw.$filter !== undefined ? compileFilter(raw.$filter, typeName) : null;
  o.orderby = raw.$orderby !== undefined ? compileOrderBy(raw.$orderby, typeName) : [];
  o.top = nonNegInt(raw.$top, '$top');
  o.skip = nonNegInt(raw.$skip, '$skip');
  if (raw.$count !== undefined && !['true', 'false'].includes(String(raw.$count))) throw bad('$count must be true or false');
  o.count = String(raw.$count) === 'true';
  o.search = raw.$search !== undefined ? parseSearch(raw.$search) : null;
  o.expand = raw.$expand !== undefined ? parseExpand(raw.$expand, typeName) : [];
  return o;
}

function parseExpand(text, typeName) {
  const out = [];
  for (const item of splitTop(String(text), ',')) {
    const m = /^([\w*]+)(?:\((.*)\))?$/s.exec(item);
    if (!m) throw bad(`Invalid $expand item "${item}"`);
    const [, name, inner] = m;
    const navs = name === '*' ? ENTITIES[typeName].nav : [member(typeName, name)?.nav].filter(Boolean);
    if (!navs.length) throw bad(`Could not find a navigation property named '${name}' on type '${NS}.${typeName}'`);
    for (const nav of navs) {
      const raw = {};
      for (const part of inner ? splitTop(inner, ';') : []) {
        const eq = part.indexOf('=');
        if (eq < 1) throw bad(`Invalid option "${part}" in $expand=${name}(…)`);
        raw[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
      const target = SETS[nav.target].type;
      const options = parseOptions(raw, target, { nested: true });
      if (!nav.many && (options.filter || options.orderby.length || options.top !== undefined || options.skip !== undefined || options.count)) {
        throw bad(`$filter, $orderby, $top, $skip and $count apply to collections; ${name} is a single entity`);
      }
      out.push({ nav, options });
    }
  }
  return out;
}

// $search: space-separated terms (AND), "quoted phrases", OR between terms, NOT term.
function parseSearch(text) {
  const tokens = String(text).match(/"[^"]*"|\S+/g) || [];
  const groups = [[]];
  let negate = false;
  for (const tok of tokens) {
    if (tok === 'OR') { groups.push([]); continue; }
    if (tok === 'AND') continue;
    if (tok === 'NOT') { negate = true; continue; }
    groups[groups.length - 1].push({ term: tok.replace(/^"|"$/g, '').toLowerCase(), negate });
    negate = false;
  }
  const text2 = (v, out = []) => {
    if (v === null || v === undefined) return out;
    if (typeof v === 'object') { for (const x of Object.values(v)) text2(x, out); return out; }
    out.push(String(v).toLowerCase());
    return out;
  };
  return (doc) => {
    const hay = text2(doc).join('\u0000');
    return groups.some((g) => g.length && g.every(({ term, negate: n }) => hay.includes(term) !== n));
  };
}

// Filter, search and sort (no paging). Returns the matching list.
function query(list, options, data) {
  let out = list;
  if (options.filter) out = out.filter((d) => options.filter(d, data));
  if (options.search) out = out.filter(options.search);
  return sortBy(out, options.orderby, data);
}

const keyPath = (set, id) => `${set}(${id})`;

// Serialize one entity with the requested projection and metadata level ('none' | 'minimal' | 'full').
function serialize(typeName, doc, options, data, ctx) {
  const e = ENTITIES[typeName];
  const full = shape(typeName, doc);
  const out = {};
  if (ctx.metadata !== 'none') out['@odata.etag'] = `W/${etagOf(full)}`;
  if (ctx.metadata === 'full') {
    out['@odata.type'] = `#${NS}.${typeName}`;
    out['@odata.id'] = `${ctx.root}/${keyPath(e.set, doc.id)}`;
    out['@odata.editLink'] = keyPath(e.set, doc.id);
  }
  const sel = options?.select;
  if (!sel || sel.includes('*')) Object.assign(out, full);
  else {
    if (!sel.includes('id')) out.id = full.id; // the key is always returned
    for (const s of sel) {
      const [head, sub] = s.split('/');
      if (member(typeName, head)?.kind !== 'prop') continue;
      if (sub === undefined) out[head] = full[head];
      else {
        const v = full[head];
        out[head] = { ...(out[head] && typeof out[head] === 'object' ? out[head] : {}), ...(v && typeof v === 'object' ? { [sub]: v[sub] ?? null } : {}) };
        if (v == null) out[head] = null;
      }
    }
  }
  for (const { nav, options: no } of options?.expand || []) {
    const targetType = SETS[nav.target].type;
    if (nav.many) {
      let list = query(data.children(nav, doc), no, data);
      if (no.count) out[`${nav.name}@odata.count`] = list.length;
      list = list.slice(no.skip || 0, no.top !== undefined ? (no.skip || 0) + no.top : undefined);
      out[nav.name] = list.map((x) => serialize(targetType, x, no, data, ctx));
    } else {
      const p = data.parent(nav, doc);
      out[nav.name] = p ? serialize(targetType, p, no, data, ctx) : null;
    }
  }
  if (ctx.metadata === 'full') {
    for (const nav of e.nav) if (!(options?.expand || []).some((x) => x.nav === nav)) out[`${nav.name}@odata.navigationLink`] = `${keyPath(e.set, doc.id)}/${nav.name}`;
  }
  return out;
}

// Context URL fragment for a projection: Employees(firstName,department()) etc.
function projection(options) {
  const parts = [];
  if (options?.select && !options.select.includes('*')) parts.push(...options.select);
  for (const { nav, options: no } of options?.expand || []) parts.push(`${nav.name}(${projection(no).replace(/^\(|\)$/g, '')})`);
  return parts.length ? `(${parts.join(',')})` : '';
}

module.exports = { parseOptions, query, serialize, projection, splitTop, keyPath };
