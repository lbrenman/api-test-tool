'use strict';
// OData v4 common expression syntax ($filter, $orderby) compiled to plain JS functions.
//
//   operators: eq ne gt ge lt le, in (4.01), and or not, add sub mul div divby mod, unary -
//   functions: contains startswith endswith length indexof substring tolower toupper trim concat
//              matchesPattern year month day hour minute second date now round floor ceiling
//   paths:     property, complex/property, navigation/property (to-one), collection/any(x: …),
//              collection/all(x: …), $it
//   literals:  'text' ('' escapes '), numbers, true false null, 2024-05-01, 2024-05-01T10:00:00Z, GUIDs
//
// compileFilter(text, typeName) -> (entity, data) => boolean, after checking every property against the
// model (unknown properties are a 400 like real OData services). data resolves navigation properties.
const { HttpError } = require('../../util/problem');
const { member, ENTITIES, SETS } = require('./model');

const bad = (message) => new HttpError(400, message, { code: 'invalid-query-option' });

// ---- lexer ---------------------------------------------------------------------------------
const RX = [
  ['guid', /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\w-])/],
  ['dto', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/],
  ['date', /^\d{4}-\d{2}-\d{2}(?![\d:T])/],
  ['num', /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[mMdDfFlL]?(?![\w.])/],
  ['id', /^[A-Za-z_$][A-Za-z0-9_]*/],
];

function lex(text) {
  const src = String(text);
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if ('(),/:'.includes(ch)) { toks.push({ t: ch, pos: i }); i += 1; continue; }
    if (ch === '-') {
      const prev = toks[toks.length - 1];
      const afterValue = prev && ['num', 'id', 'str', ')', 'date', 'dto', 'guid'].includes(prev.t) && !(prev.t === 'id' && /^(eq|ne|gt|ge|lt|le|and|or|not|add|sub|mul|div|divby|mod|in)$/.test(prev.v));
      const m = afterValue ? null : RX[3][1].exec(src.slice(i + 1));
      if (m) { toks.push({ t: 'num', v: -parseFloat(m[0].replace(/[mMdDfFlL]$/, '')), pos: i }); i += 1 + m[0].length; continue; }
      toks.push({ t: '-', pos: i });
      i += 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) throw bad(`Unterminated string literal at position ${i}`);
        if (src[j] === "'") { if (src[j + 1] === "'") { s += "'"; j += 2; continue; } break; }
        s += src[j]; j += 1;
      }
      toks.push({ t: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    let matched = false;
    for (const [t, rx] of RX) {
      const m = rx.exec(src.slice(i));
      if (m) {
        const raw = m[0];
        const v = t === 'num' ? parseFloat(raw.replace(/[mMdDfFlL]$/, '')) : raw;
        toks.push({ t, v, pos: i });
        i += raw.length;
        matched = true;
        break;
      }
    }
    if (!matched) throw bad(`Syntax error at position ${i} in "${src}"`);
  }
  toks.push({ t: 'eof', pos: src.length });
  return toks;
}

// ---- parser (AST) --------------------------------------------------------------------------
const CMP = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);
const FUNCS = {
  contains: 2, startswith: 2, endswith: 2, length: 1, indexof: 2, substring: [2, 3], tolower: 1, toupper: 1, trim: 1, concat: 2,
  matchesPattern: 2, year: 1, month: 1, day: 1, hour: 1, minute: 1, second: 1, date: 1, now: 0, round: 1, floor: 1, ceiling: 1,
};

function parser(text) {
  const toks = lex(text);
  let k = 0;
  const peek = () => toks[k];
  const isId = (v) => peek().t === 'id' && peek().v === v;
  const take = (t) => {
    const tok = peek();
    if (tok.t !== t) throw bad(`Expected "${t}" at position ${tok.pos} in "${text}"`);
    k += 1;
    return tok;
  };

  function expr() { return or(); }
  function or() { let l = and(); while (isId('or')) { k += 1; l = { op: 'or', l, r: and() }; } return l; }
  function and() { let l = cmp(); while (isId('and')) { k += 1; l = { op: 'and', l, r: cmp() }; } return l; }
  function cmp() {
    const l = add();
    if (peek().t === 'id' && CMP.has(peek().v)) { const op = peek().v; k += 1; return { op, l, r: add() }; }
    if (isId('in')) {
      k += 1;
      take('(');
      const list = [];
      if (peek().t !== ')') { list.push(add()); while (peek().t === ',') { k += 1; list.push(add()); } }
      take(')');
      return { op: 'in', l, list };
    }
    if (isId('has')) throw bad('The "has" operator is for enumerations, which this model does not use');
    return l;
  }
  function add() { let l = mul(); while (isId('add') || isId('sub')) { const op = peek().v; k += 1; l = { op, l, r: mul() }; } return l; }
  function mul() { let l = unary(); while (['mul', 'div', 'divby', 'mod'].some(isId)) { const op = peek().v; k += 1; l = { op, l, r: unary() }; } return l; }
  function unary() {
    if (peek().t === '-') { k += 1; return { op: 'neg', e: unary() }; }
    if (isId('not')) { k += 1; return { op: 'not', e: unary() }; }
    return primary();
  }
  function primary() {
    const tok = peek();
    if (tok.t === '(') { k += 1; const e = expr(); take(')'); return e; }
    if (tok.t === 'str') { k += 1; return { lit: tok.v }; }
    if (tok.t === 'num') { k += 1; return { lit: tok.v }; }
    if (tok.t === 'date' || tok.t === 'dto' || tok.t === 'guid') { k += 1; return { lit: tok.v, kind: tok.t }; }
    if (tok.t === 'id') {
      if (tok.v === 'true' || tok.v === 'false') { k += 1; return { lit: tok.v === 'true' }; }
      if (tok.v === 'null') { k += 1; return { lit: null }; }
      if (toks[k + 1].t === '(' && Object.hasOwn(FUNCS, tok.v)) {
        k += 2;
        const args = [];
        if (peek().t !== ')') { args.push(expr()); while (peek().t === ',') { k += 1; args.push(expr()); } }
        take(')');
        const arity = [].concat(FUNCS[tok.v]);
        if (!arity.includes(args.length)) throw bad(`${tok.v}() takes ${arity.join(' or ')} argument(s), got ${args.length}`);
        return { fn: tok.v, args };
      }
      if (toks[k + 1].t === '(') throw bad(`Unknown function "${tok.v}"`);
      return path();
    }
    throw bad(`Unexpected ${tok.t === 'eof' ? 'end of expression' : `"${tok.v ?? tok.t}"`} at position ${tok.pos} in "${text}"`);
  }
  function path() {
    const segs = [take('id').v];
    while (peek().t === '/') {
      k += 1;
      const name = take('id').v;
      if ((name === 'any' || name === 'all') && peek().t === '(') {
        k += 1;
        if (peek().t === ')') {
          if (name === 'all') throw bad('all() needs a lambda expression');
          k += 1;
          segs.push({ lambda: 'any', v: null, body: null });
          continue;
        }
        const v = take('id').v;
        take(':');
        const body = expr();
        take(')');
        segs.push({ lambda: name, v, body });
      } else segs.push(name);
    }
    return { path: segs };
  }
  return { expr, peek, take, isId, k: () => k, skip: () => { k += 1; } };
}

// ---- compiler --------------------------------------------------------------------------------
const ISO_DT = /^\d{4}-\d{2}-\d{2}T/;
function compare(a, b) {
  if (typeof a === 'string' && typeof b === 'string' && ISO_DT.test(a) && ISO_DT.test(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function equal(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return compare(a, b) === 0;
}

const datePart = (v, fn) => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) return null;
  return fn(d);
};

const FN_IMPL = {
  contains: (s, x) => (s == null || x == null ? null : String(s).includes(String(x))),
  startswith: (s, x) => (s == null || x == null ? null : String(s).startsWith(String(x))),
  endswith: (s, x) => (s == null || x == null ? null : String(s).endsWith(String(x))),
  length: (s) => (s == null ? null : Array.isArray(s) ? s.length : String(s).length),
  indexof: (s, x) => (s == null || x == null ? null : String(s).indexOf(String(x))),
  substring: (s, i, n) => (s == null ? null : n === undefined ? String(s).slice(i) : String(s).substr(i, n)),
  tolower: (s) => (s == null ? null : String(s).toLowerCase()),
  toupper: (s) => (s == null ? null : String(s).toUpperCase()),
  trim: (s) => (s == null ? null : String(s).trim()),
  concat: (a, b) => (a == null || b == null ? null : `${a}${b}`),
  matchesPattern: (s, p) => { if (s == null || p == null) return null; try { return new RegExp(p).test(String(s)); } catch { throw bad(`Invalid pattern for matchesPattern: ${p}`); } },
  year: (v) => datePart(v, (d) => d.getUTCFullYear()),
  month: (v) => datePart(v, (d) => d.getUTCMonth() + 1),
  day: (v) => datePart(v, (d) => d.getUTCDate()),
  hour: (v) => datePart(v, (d) => d.getUTCHours()),
  minute: (v) => datePart(v, (d) => d.getUTCMinutes()),
  second: (v) => datePart(v, (d) => d.getUTCSeconds()),
  date: (v) => datePart(v, (d) => d.toISOString().slice(0, 10)),
  now: () => new Date().toISOString(),
  round: (n) => (n == null ? null : Math.round(n)),
  floor: (n) => (n == null ? null : Math.floor(n)),
  ceiling: (n) => (n == null ? null : Math.ceil(n)),
};

const ARITH = {
  add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b,
  div: (a, b) => (Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b), divby: (a, b) => a / b, mod: (a, b) => a % b,
};

// scope: { type: entity type name, vars: { name: { type, coll } } }
function compile(node, scope) {
  if ('lit' in node) { const v = node.lit; return () => v; }
  if (node.fn) {
    const args = node.args.map((a) => compile(a, scope));
    const impl = FN_IMPL[node.fn];
    return (env) => impl(...args.map((a) => a(env)));
  }
  if (node.path) return compilePath(node.path, scope).get;
  switch (node.op) {
    case 'or': { const l = compile(node.l, scope); const r = compile(node.r, scope); return (env) => !!l(env) || !!r(env); }
    case 'and': { const l = compile(node.l, scope); const r = compile(node.r, scope); return (env) => !!l(env) && !!r(env); }
    case 'not': { const e = compile(node.e, scope); return (env) => { const v = e(env); return v === null || v === undefined ? null : !v; }; }
    case 'neg': { const e = compile(node.e, scope); return (env) => { const v = e(env); return v == null ? null : -v; }; }
    case 'in': {
      const l = compile(node.l, scope);
      const list = node.list.map((x) => compile(x, scope));
      return (env) => { const v = l(env); return list.some((x) => equal(v, x(env))); };
    }
    case 'eq': case 'ne': {
      const l = compile(node.l, scope); const r = compile(node.r, scope);
      return node.op === 'eq' ? (env) => equal(l(env), r(env)) : (env) => !equal(l(env), r(env));
    }
    case 'gt': case 'ge': case 'lt': case 'le': {
      const l = compile(node.l, scope); const r = compile(node.r, scope);
      const test = { gt: (c) => c > 0, ge: (c) => c >= 0, lt: (c) => c < 0, le: (c) => c <= 0 }[node.op];
      return (env) => { const a = l(env); const b = r(env); return a == null || b == null ? false : test(compare(a, b)); };
    }
    default: {
      const f = ARITH[node.op];
      if (!f) throw bad(`Unsupported operator ${node.op}`);
      const l = compile(node.l, scope); const r = compile(node.r, scope);
      return (env) => { const a = l(env); const b = r(env); return a == null || b == null ? null : f(Number(a), Number(b)); };
    }
  }
}

// Returns { get(env), type, coll }.
function compilePath(segs, scope) {
  let get;
  let type;
  let coll = false;
  let rest = segs;
  const first = segs[0];
  if (first === '$it') { get = (env) => env.it; type = scope.type; rest = segs.slice(1); }
  else if (typeof first === 'string' && scope.vars && Object.hasOwn(scope.vars, first)) {
    const v = scope.vars[first];
    get = (env) => env.vars[first];
    ({ type } = v);
    rest = segs.slice(1);
  } else { get = (env) => env.it; type = scope.type; }

  for (const seg of rest) {
    if (typeof seg === 'object') { // lambda
      if (!coll) throw bad(`${seg.lambda}() needs a collection`);
      const prev = get;
      if (!seg.body) { get = (env) => { const c = prev(env); return Array.isArray(c) && c.length > 0; }; }
      else {
        const body = compile(seg.body, { type: scope.type, vars: { ...(scope.vars || {}), [seg.v]: { type } } });
        const all = seg.lambda === 'all';
        get = (env) => {
          const c = prev(env);
          if (!Array.isArray(c)) return all;
          const test = (x) => !!body({ ...env, vars: { ...(env.vars || {}), [seg.v]: x } });
          return all ? c.every(test) : c.some(test);
        };
      }
      type = 'Edm.Boolean';
      coll = false;
      continue;
    }
    if (coll) throw bad(`"${seg}": use any() or all() to look inside a collection`);
    if (type.startsWith('Edm.')) throw bad(`"${seg}" cannot follow a primitive value`);
    const m = member(type, seg);
    if (!m) throw bad(`Could not find a property named '${seg}' on type 'ApiTestTool.${type}'`);
    const prev = get;
    if (m.kind === 'prop') {
      get = (env) => { const v = prev(env); return v == null ? null : (v[seg] ?? null); };
      ({ type } = m.prop);
      coll = !!m.prop.coll;
    } else {
      const { nav } = m;
      if (nav.many) get = (env) => { const v = prev(env); return v == null ? [] : env.data.children(nav, v); };
      else get = (env) => { const v = prev(env); return v == null ? null : env.data.parent(nav, v); };
      type = SETS[nav.target].type;
      coll = !!nav.many;
    }
  }
  return { get, type, coll };
}

function compileFilter(text, typeName) {
  const p = parser(text);
  const ast = p.expr();
  if (p.peek().t !== 'eof') throw bad(`Unexpected "${p.peek().v ?? p.peek().t}" at position ${p.peek().pos} in $filter`);
  const fn = compile(ast, { type: typeName, vars: {} });
  return (it, data) => !!fn({ it, data, vars: {} });
}

// $orderby=lastName desc,department/name -> [{ get(entity, data), desc }]
function compileOrderBy(text, typeName) {
  const p = parser(text);
  const out = [];
  for (;;) {
    const ast = p.expr();
    let desc = false;
    if (p.isId('desc')) { desc = true; p.skip(); } else if (p.isId('asc')) p.skip();
    const fn = compile(ast, { type: typeName, vars: {} });
    out.push({ get: (it, data) => fn({ it, data, vars: {} }), desc });
    if (p.peek().t === ',') { p.skip(); continue; }
    if (p.peek().t !== 'eof') throw bad(`Unexpected "${p.peek().v ?? p.peek().t}" in $orderby`);
    return out;
  }
}

function sortBy(list, order, data) {
  if (!order.length) return list;
  return list.slice().sort((a, b) => {
    for (const { get, desc } of order) {
      const x = get(a, data);
      const y = get(b, data);
      let c;
      if (x == null || y == null) c = x == null && y == null ? 0 : x == null ? -1 : 1; // nulls first ascending
      else c = compare(x, y);
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  });
}

module.exports = { compileFilter, compileOrderBy, sortBy, lex, compare, ENTITIES };
