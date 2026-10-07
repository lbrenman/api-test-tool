'use strict';
// XML Schema (XSD 1.0) subset for the WSDL contract tester: parse <xsd:schema> into a JSON model,
// generate sample instances, and validate instances. Covers what SOAP contracts use in practice:
// global/local elements and refs, complex types (sequence, choice, all, nested particles, groups,
// complexContent extension/restriction, simpleContent, mixed, attributes), simple types (restriction
// facets, enumerations, patterns, lists, unions), xsd:any, nillable, minOccurs/maxOccurs, xsi:type.
// Identity constraints, substitution groups and redefine are not checked.
const { NS, elements, child, attr, textOf, isNil, escapeXml, resolveQName, qkey } = require('../../../../util/xml');
const { fromPattern } = require('../../sample');

const UNBOUNDED = -1;

// ---------------------------------------------------------------- model
// model = { [ns]: { elements: {local: Decl}, types: {local: Type}, groups: {local: Particle}, attributeGroups: {local: Attr[]} } }

function nsBucket(model, ns) {
  if (!model[ns]) model[ns] = { elements: {}, types: {}, groups: {}, attributeGroups: {} };
  return model[ns];
}

function occurs(el) {
  const min = attr(el, 'minOccurs');
  const max = attr(el, 'maxOccurs');
  return { min: min === undefined ? 1 : Number(min), max: max === undefined ? 1 : max === 'unbounded' ? UNBOUNDED : Number(max) };
}

function parseSimple(el, s) {
  const restr = child(el, 'restriction', NS.xsd);
  const list = child(el, 'list', NS.xsd);
  const union = child(el, 'union', NS.xsd);
  if (list) {
    const itemType = attr(list, 'itemType');
    return { kind: 'simple', list: itemType ? resolveQName(list, itemType) : null, listInline: child(list, 'simpleType', NS.xsd) ? parseSimple(child(list, 'simpleType', NS.xsd), s) : null };
  }
  if (union) {
    const members = String(attr(union, 'memberTypes') || '').split(/\s+/).filter(Boolean).map((m) => resolveQName(union, m));
    return { kind: 'simple', union: members, unionInline: elements(union, 'simpleType', NS.xsd).map((x) => parseSimple(x, s)) };
  }
  const def = { kind: 'simple', base: null, facets: {} };
  if (restr) {
    const base = attr(restr, 'base');
    def.base = base ? resolveQName(restr, base) : null;
    if (!base && child(restr, 'simpleType', NS.xsd)) def.baseInline = parseSimple(child(restr, 'simpleType', NS.xsd), s);
    for (const f of elements(restr)) {
      if (f.ns !== NS.xsd) continue;
      const v = attr(f, 'value');
      if (f.local === 'enumeration') (def.facets.enumeration ||= []).push(v);
      else if (f.local === 'pattern') (def.facets.pattern ||= []).push(v);
      else if (['length', 'minLength', 'maxLength', 'totalDigits', 'fractionDigits'].includes(f.local)) def.facets[f.local] = Number(v);
      else if (['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'].includes(f.local)) def.facets[f.local] = v;
    }
  }
  return def;
}

function parseAttributes(el) {
  const out = [];
  for (const a of elements(el)) {
    if (a.ns !== NS.xsd) continue;
    if (a.local === 'attribute') {
      const ref = attr(a, 'ref');
      out.push({
        name: ref ? resolveQName(a, ref).local : attr(a, 'name'),
        type: attr(a, 'type') ? resolveQName(a, attr(a, 'type')) : null,
        use: attr(a, 'use') || 'optional',
        fixed: attr(a, 'fixed'), default: attr(a, 'default'),
      });
    } else if (a.local === 'attributeGroup' && attr(a, 'ref')) out.push({ groupRef: resolveQName(a, attr(a, 'ref')) });
    else if (a.local === 'anyAttribute') out.push({ any: true });
  }
  return out;
}

function parseParticle(el, s) {
  const kind = el.local; // sequence | choice | all
  const p = { kind, ...occurs(el), items: [] };
  for (const c of elements(el)) {
    if (c.ns !== NS.xsd) continue;
    if (c.local === 'element') p.items.push(parseElement(c, s, false));
    else if (['sequence', 'choice', 'all'].includes(c.local)) p.items.push(parseParticle(c, s));
    else if (c.local === 'group' && attr(c, 'ref')) p.items.push({ kind: 'groupRef', ref: resolveQName(c, attr(c, 'ref')), ...occurs(c) });
    else if (c.local === 'any') p.items.push({ kind: 'any', ...occurs(c), namespace: attr(c, 'namespace') || '##any', processContents: attr(c, 'processContents') || 'strict' });
  }
  return p;
}

function contentParticle(el, s) {
  const p = elements(el).find((c) => c.ns === NS.xsd && ['sequence', 'choice', 'all'].includes(c.local));
  if (p) return parseParticle(p, s);
  const g = child(el, 'group', NS.xsd);
  if (g && attr(g, 'ref')) return { kind: 'sequence', min: 1, max: 1, items: [{ kind: 'groupRef', ref: resolveQName(g, attr(g, 'ref')), ...occurs(g) }] };
  return null;
}

function parseComplex(el, s) {
  const t = { kind: 'complex', mixed: attr(el, 'mixed') === 'true', abstract: attr(el, 'abstract') === 'true', content: null, attributes: [], base: null, derivation: null, simpleContent: null };
  const cc = child(el, 'complexContent', NS.xsd);
  const sc = child(el, 'simpleContent', NS.xsd);
  if (cc) {
    if (attr(cc, 'mixed') === 'true') t.mixed = true;
    const d = child(cc, 'extension', NS.xsd) || child(cc, 'restriction', NS.xsd);
    if (d) {
      t.derivation = d.local;
      t.base = attr(d, 'base') ? resolveQName(d, attr(d, 'base')) : null;
      t.content = contentParticle(d, s);
      t.attributes = parseAttributes(d);
    }
  } else if (sc) {
    const d = child(sc, 'extension', NS.xsd) || child(sc, 'restriction', NS.xsd);
    if (d) {
      t.derivation = d.local;
      t.base = attr(d, 'base') ? resolveQName(d, attr(d, 'base')) : null;
      t.simpleContent = d.local === 'restriction' ? parseSimple(sc, s) : { kind: 'simple', base: t.base, facets: {} };
      t.attributes = parseAttributes(d);
    }
  } else {
    t.content = contentParticle(el, s);
    t.attributes = parseAttributes(el);
  }
  return t;
}

// s = { tns, elementForm, attributeForm }
function parseElement(el, s, global) {
  const ref = attr(el, 'ref');
  if (ref) return { kind: 'element', ref: resolveQName(el, ref), ...occurs(el) };
  const name = attr(el, 'name');
  const form = attr(el, 'form') || s.elementForm;
  const d = {
    kind: 'element',
    name,
    ns: global || form === 'qualified' ? s.tns : '',
    type: attr(el, 'type') ? resolveQName(el, attr(el, 'type')) : null,
    typeDef: null,
    nillable: attr(el, 'nillable') === 'true',
    fixed: attr(el, 'fixed'),
    default: attr(el, 'default'),
    ...(global ? { min: 1, max: 1 } : occurs(el)),
  };
  const ct = child(el, 'complexType', NS.xsd);
  const st = child(el, 'simpleType', NS.xsd);
  if (ct) d.typeDef = parseComplex(ct, s);
  else if (st) d.typeDef = parseSimple(st, s);
  else if (!d.type) d.type = { ns: NS.xsd, local: 'anyType' };
  return d;
}

/** Add one <xsd:schema> element to the model. Returns the schema's imports/includes. */
function addSchema(model, schemaEl, { tnsOverride } = {}) {
  const tns = tnsOverride ?? attr(schemaEl, 'targetNamespace') ?? '';
  const s = { tns, elementForm: attr(schemaEl, 'elementFormDefault') || 'unqualified', attributeForm: attr(schemaEl, 'attributeFormDefault') || 'unqualified' };
  const b = nsBucket(model, tns);
  const refs = [];
  for (const c of elements(schemaEl)) {
    if (c.ns !== NS.xsd) continue;
    const name = attr(c, 'name');
    if (c.local === 'element') b.elements[name] = parseElement(c, s, true);
    else if (c.local === 'complexType') b.types[name] = parseComplex(c, s);
    else if (c.local === 'simpleType') b.types[name] = parseSimple(c, s);
    else if (c.local === 'group') { const p = elements(c).find((x) => ['sequence', 'choice', 'all'].includes(x.local)); if (p) b.groups[name] = parseParticle(p, s); }
    else if (c.local === 'attributeGroup') b.attributeGroups[name] = parseAttributes(c);
    else if (c.local === 'import') refs.push({ kind: 'import', namespace: attr(c, 'namespace') || '', location: attr(c, 'schemaLocation') || null });
    else if (c.local === 'include') refs.push({ kind: 'include', namespace: tns, location: attr(c, 'schemaLocation') || null });
  }
  return { tns, elementForm: s.elementForm, refs };
}

// ---------------------------------------------------------------- lookups
const isXsd = (q) => q && q.ns === NS.xsd;
const findElement = (model, q) => (q && model[q.ns]?.elements[q.local]) || null;
const findType = (model, q) => (q && model[q.ns]?.types[q.local]) || null;
const findGroup = (model, q) => (q && model[q.ns]?.groups[q.local]) || null;

function resolveRef(model, d) {
  if (!d.ref) return d;
  const g = findElement(model, d.ref);
  return g ? { ...g, min: d.min, max: d.max, refKey: qkey(d.ref) } : null;
}

/** Type definition of an element declaration: { builtin } | complex | simple | null (unknown). */
function typeOf(model, d) {
  if (d.typeDef) return d.typeDef;
  if (isXsd(d.type)) return { kind: 'builtin', name: d.type.local };
  return findType(model, d.type);
}

// Facets of a simple type, merging restrictions down to the builtin base.
function flattenSimple(model, def, depth = 0) {
  if (!def || depth > 20) return { builtin: 'string', facets: {} };
  if (def.kind === 'builtin') return { builtin: def.name, facets: {} };
  if (def.list || def.listInline) return { list: true, item: def.listInline || (isXsd(def.list) ? { kind: 'builtin', name: def.list.local } : findType(model, def.list)), facets: {} };
  if (def.union || def.unionInline) return { union: true, members: [...(def.union || []).map((q) => (isXsd(q) ? { kind: 'builtin', name: q.local } : findType(model, q))), ...(def.unionInline || [])].filter(Boolean), facets: {} };
  let base;
  if (def.baseInline) base = flattenSimple(model, def.baseInline, depth + 1);
  else if (isXsd(def.base)) base = { builtin: def.base.local, facets: {} };
  else if (def.base) {
    const t = findType(model, def.base);
    base = t && t.kind === 'simple' ? flattenSimple(model, t, depth + 1) : { builtin: 'string', facets: {}, unresolved: qkey(def.base) };
  } else base = { builtin: 'string', facets: {} };
  return { ...base, facets: { ...base.facets, ...def.facets } };
}

// Effective content particle and attributes of a complex type, following extension chains.
function effectiveComplex(model, t, depth = 0) {
  if (!t || depth > 20) return { content: null, attributes: [], simple: null, mixed: false };
  if (t.simpleContent) {
    const base = t.base && !isXsd(t.base) ? findType(model, t.base) : null;
    let simple;
    if (base && base.kind === 'complex') simple = effectiveComplex(model, base, depth + 1).simple;
    else simple = flattenSimple(model, t.base && isXsd(t.base) ? { kind: 'builtin', name: t.base.local } : base || { kind: 'builtin', name: 'string' });
    if (t.derivation === 'restriction' && t.simpleContent.facets) simple = { ...simple, facets: { ...simple.facets, ...t.simpleContent.facets } };
    return { content: null, attributes: t.attributes, simple, mixed: false };
  }
  if (t.derivation === 'extension' && t.base) {
    if (isXsd(t.base)) {
      if (t.base.local === 'anyType') return { content: t.content, attributes: t.attributes, simple: null, mixed: t.mixed };
      return { content: null, attributes: t.attributes, simple: { builtin: t.base.local, facets: {} }, mixed: false };
    }
    const base = effectiveComplex(model, findType(model, t.base), depth + 1);
    const items = [base.content, t.content].filter(Boolean);
    const content = items.length > 1 ? { kind: 'sequence', min: 1, max: 1, items } : items[0] || null;
    return { content, attributes: [...base.attributes, ...t.attributes], simple: base.simple, mixed: t.mixed || base.mixed };
  }
  return { content: t.content, attributes: t.attributes, simple: null, mixed: t.mixed };
}

// ---------------------------------------------------------------- builtin values
const INT_RANGES = {
  int: [-2147483648n, 2147483647n], short: [-32768n, 32767n], byte: [-128n, 127n], long: [-9223372036854775808n, 9223372036854775807n],
  unsignedInt: [0n, 4294967295n], unsignedShort: [0n, 65535n], unsignedByte: [0n, 255n], unsignedLong: [0n, 18446744073709551615n],
  nonNegativeInteger: [0n, null], positiveInteger: [1n, null], nonPositiveInteger: [null, 0n], negativeInteger: [null, -1n], integer: [null, null],
};
const DATE = /^-?\d{4,}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(Z|[+-]\d{2}:\d{2})?$/;
const DATETIME = /^-?\d{4,}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-4]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const TIME = /^([01]\d|2[0-4]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const DURATION = /^-?P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const FLOAT = /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/;
const STRINGISH = new Set(['string', 'normalizedString', 'token', 'language', 'Name', 'NCName', 'NMTOKEN', 'NMTOKENS', 'ID', 'IDREF', 'IDREFS', 'ENTITY', 'ENTITIES', 'anyURI', 'QName', 'NOTATION', 'anySimpleType', 'anyType', 'gYear', 'gYearMonth', 'gMonth', 'gMonthDay', 'gDay']);

function checkBuiltin(name, raw) {
  const v = name === 'string' || name === 'anyType' || name === 'anySimpleType' ? raw : raw.trim();
  if (STRINGISH.has(name)) return null;
  if (name === 'boolean') return /^(true|false|1|0)$/.test(v) ? null : 'must be an xsd:boolean (true, false, 1 or 0)';
  if (INT_RANGES[name]) {
    if (!/^[+-]?\d+$/.test(v)) return `must be an xsd:${name}`;
    const n = BigInt(v);
    const [lo, hi] = INT_RANGES[name];
    if ((lo !== null && n < lo) || (hi !== null && n > hi)) return `is out of range for xsd:${name}`;
    return null;
  }
  if (name === 'decimal') return DECIMAL.test(v) ? null : 'must be an xsd:decimal';
  if (name === 'float' || name === 'double') return FLOAT.test(v) ? null : `must be an xsd:${name}`;
  if (name === 'date') return DATE.test(v) ? null : 'must be an xsd:date (YYYY-MM-DD)';
  if (name === 'dateTime') return DATETIME.test(v) ? null : 'must be an xsd:dateTime (YYYY-MM-DDThh:mm:ss)';
  if (name === 'time') return TIME.test(v) ? null : 'must be an xsd:time (hh:mm:ss)';
  if (name === 'duration') return DURATION.test(v) ? null : 'must be an xsd:duration (e.g. P1DT2H)';
  if (name === 'base64Binary') return /^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(v) ? null : 'must be xsd:base64Binary';
  if (name === 'hexBinary') return /^([0-9a-fA-F]{2})*$/.test(v) ? null : 'must be xsd:hexBinary';
  return null;
}

function isNumericBuiltin(name) { return name === 'decimal' || name === 'float' || name === 'double' || !!INT_RANGES[name]; }

function checkSimple(model, flat, raw) {
  if (flat.list) {
    const items = raw.trim().split(/\s+/).filter(Boolean);
    for (const it of items) { const e = checkSimple(model, flattenSimple(model, flat.item), it); if (e) return `list item "${it}" ${e}`; }
    return null;
  }
  if (flat.union) {
    if (!flat.members.length) return null;
    return flat.members.some((m) => !checkSimple(model, flattenSimple(model, m), raw)) ? null : 'does not match any member type of the union';
  }
  const base = flat.builtin || 'string';
  const err = checkBuiltin(base, raw);
  if (err) return err;
  const v = base === 'string' ? raw : raw.trim();
  const f = flat.facets || {};
  if (f.enumeration && !f.enumeration.includes(v)) return `must be one of: ${f.enumeration.slice(0, 12).join(', ')}${f.enumeration.length > 12 ? ', …' : ''}`;
  if (f.pattern && f.pattern.length) {
    const ok = f.pattern.some((p) => { try { return new RegExp(`^(?:${p})$`, 'u').test(v); } catch { return true; } });
    if (!ok) return `does not match the pattern ${f.pattern[0]}`;
  }
  const len = [...v].length;
  if (f.length !== undefined && len !== f.length) return `must be exactly ${f.length} characters`;
  if (f.minLength !== undefined && len < f.minLength) return `must be at least ${f.minLength} characters`;
  if (f.maxLength !== undefined && len > f.maxLength) return `must be at most ${f.maxLength} characters`;
  if (isNumericBuiltin(base)) {
    const n = Number(v);
    if (f.minInclusive !== undefined && n < Number(f.minInclusive)) return `must be >= ${f.minInclusive}`;
    if (f.maxInclusive !== undefined && n > Number(f.maxInclusive)) return `must be <= ${f.maxInclusive}`;
    if (f.minExclusive !== undefined && n <= Number(f.minExclusive)) return `must be > ${f.minExclusive}`;
    if (f.maxExclusive !== undefined && n >= Number(f.maxExclusive)) return `must be < ${f.maxExclusive}`;
    const digits = v.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '');
    const [ip, fp = ''] = digits.split('.');
    if (f.totalDigits !== undefined && (ip.replace(/^0+$/, '') + fp.replace(/0+$/, '')).length > f.totalDigits) return `must have at most ${f.totalDigits} digits`;
    if (f.fractionDigits !== undefined && fp.replace(/0+$/, '').length > f.fractionDigits) return `must have at most ${f.fractionDigits} fraction digits`;
  }
  return null;
}

// ---------------------------------------------------------------- validation
class Validator {
  constructor(model) { this.model = model; }

  /** Validate an element instance against a declaration. errors: [{ pointer, message }] */
  element(el, declIn, path, errors, depth = 0) {
    if (depth > 64) { errors.push({ pointer: path, message: 'nesting too deep to validate' }); return; }
    const decl = resolveRef(this.model, declIn);
    if (!decl) { errors.push({ pointer: path, message: `element ref ${qkey(declIn.ref)} is not defined in the schema` }); return; }
    if (isNil(el)) {
      if (!decl.nillable) errors.push({ pointer: path, message: 'is xsi:nil but the element is not nillable' });
      else if (elements(el).length || el.text.trim()) errors.push({ pointer: path, message: 'is xsi:nil but has content' });
      return;
    }
    let t = typeOf(this.model, decl);
    const xsiType = attr(el, 'type', NS.xsi);
    if (xsiType) {
      const q = resolveQName(el, xsiType);
      const derived = isXsd(q) ? { kind: 'builtin', name: q.local } : findType(this.model, q);
      if (derived) t = derived; else errors.push({ pointer: path, message: `xsi:type ${xsiType} is not defined in the schema` });
    }
    if (!t) { errors.push({ pointer: path, message: `type ${qkey(decl.type)} is not defined in the schema` }); return; }
    if (t.kind === 'builtin') {
      if (t.name === 'anyType') return;
      if (elements(el).length) { errors.push({ pointer: path, message: `must be a simple xsd:${t.name} value, not contain elements` }); return; }
      const e = checkBuiltin(t.name, el.text);
      if (e) errors.push({ pointer: path, message: `"${truncate(el.text.trim())}" ${e}` });
      if (decl.fixed !== undefined && el.text.trim() !== decl.fixed) errors.push({ pointer: path, message: `must be the fixed value "${decl.fixed}"` });
      return;
    }
    if (t.kind === 'simple') {
      if (elements(el).length) { errors.push({ pointer: path, message: 'must be a simple value, not contain elements' }); return; }
      const e = checkSimple(this.model, flattenSimple(this.model, t), el.text);
      if (e) errors.push({ pointer: path, message: `"${truncate(el.text.trim())}" ${e}` });
      return;
    }
    this.complex(el, t, path, errors, depth);
  }

  complex(el, t, path, errors, depth) {
    if (t.abstract && !attr(el, 'type', NS.xsi)) errors.push({ pointer: path, message: 'uses an abstract type without xsi:type' });
    const eff = effectiveComplex(this.model, t);
    for (const a of this.flatAttributes(eff.attributes)) {
      if (a.use === 'required' && attr(el, a.name) === undefined) errors.push({ pointer: `${path}/@${a.name}`, message: 'required attribute is missing' });
      const v = attr(el, a.name);
      if (v !== undefined && a.type) {
        const at = isXsd(a.type) ? { kind: 'builtin', name: a.type.local } : findType(this.model, a.type);
        if (at && at.kind !== 'complex') {
          const e = at.kind === 'builtin' ? checkBuiltin(at.name, v) : checkSimple(this.model, flattenSimple(this.model, at), v);
          if (e) errors.push({ pointer: `${path}/@${a.name}`, message: `"${truncate(v)}" ${e}` });
        }
      }
    }
    if (eff.simple) {
      if (elements(el).length) { errors.push({ pointer: path, message: 'must contain text only (simpleContent), not elements' }); return; }
      const e = checkSimple(this.model, eff.simple, el.text);
      if (e) errors.push({ pointer: path, message: `"${truncate(el.text.trim())}" ${e}` });
      return;
    }
    const kids = elements(el);
    if (!eff.mixed && el.text.trim()) errors.push({ pointer: path, message: 'contains text but its type only allows elements' });
    if (!eff.content) {
      if (kids.length) errors.push({ pointer: `${path}/${kids[0].local}`, message: 'is not allowed: the type has no child elements' });
      return;
    }
    const state = { i: 0 };
    const counters = {};
    this.particle(eff.content, kids, state, path, errors, depth, counters);
    if (state.i < kids.length) {
      const k = kids[state.i];
      errors.push({ pointer: `${path}/${k.local}`, message: `unexpected element {${k.ns}}${k.local}: not declared in this type, out of order, or repeated too often` });
    }
  }

  flatAttributes(list, depth = 0) {
    const out = [];
    for (const a of list || []) {
      if (a.groupRef) {
        const g = this.model[a.groupRef.ns]?.attributeGroups[a.groupRef.local];
        if (g && depth < 10) out.push(...this.flatAttributes(g, depth + 1));
      } else if (!a.any) out.push(a);
    }
    return out;
  }

  expectHint(p) {
    const names = [...this.firstSet(p, 0)].filter((x) => x !== '*').slice(0, 6).map((k) => k.replace(/^\{[^}]*\}/, ''));
    return names.length ? `; allowed here: ${names.join(', ')}` : '';
  }

  // Keys "{ns}local" (or "*") of elements that can start a particle.
  firstSet(p, depth) {
    const out = new Set();
    if (!p || depth > 20) return out;
    if (p.kind === 'element') {
      const d = resolveRef(this.model, p);
      if (d) out.add(`{${d.ns}}${d.name}`);
      return out;
    }
    if (p.kind === 'any') { out.add('*'); return out; }
    if (p.kind === 'groupRef') return this.firstSet(findGroup(this.model, p.ref), depth + 1);
    if (p.kind === 'sequence') {
      for (const it of p.items) {
        for (const k of this.firstSet(it, depth + 1)) out.add(k);
        if (this.minOf(it, depth + 1) > 0) break;
      }
      return out;
    }
    for (const it of p.items) for (const k of this.firstSet(it, depth + 1)) out.add(k);
    return out;
  }

  minOf(p, depth = 0) {
    if (!p || depth > 20) return 0;
    if (p.kind === 'element' || p.kind === 'any') return p.min;
    if (p.kind === 'groupRef') return p.min * this.minOf(findGroup(this.model, p.ref), depth + 1);
    const ms = p.items.map((i) => this.minOf(i, depth + 1));
    const inner = p.kind === 'choice' ? (ms.length ? Math.min(...ms) : 0) : ms.reduce((a, b) => a + b, 0);
    return p.min * inner;
  }

  matches(p, k, depth) {
    const fs = this.firstSet(p, depth);
    return fs.has(`{${k.ns}}${k.local}`) || fs.has('*');
  }

  // Greedy matcher. Returns the number of occurrences consumed.
  particle(p, kids, st, path, errors, depth, counters, next = null) {
    const max = p.max === UNBOUNDED ? Infinity : p.max;
    let count = 0;
    while (count < max && st.i < kids.length) {
      const before = st.i;
      if (!this.matches(p, kids[st.i], depth)) break;
      if (next && p.kind === 'any' && this.matches(next, kids[st.i], depth)) break;
      this.once(p, kids, st, path, errors, depth, counters);
      if (st.i === before) break;
      count += 1;
    }
    if (count < p.min && this.minOf({ ...p, min: 1 }, depth) > 0) {
      const name = this.describe(p);
      errors.push({ pointer: `${path}/${name}`, message: count ? `occurs ${count} time(s) but at least ${p.min} are required` : 'required element is missing' });
    }
    return count;
  }

  describe(p) {
    if (p.kind === 'element') { const d = resolveRef(this.model, p); return d ? d.name : p.ref?.local; }
    if (p.kind === 'groupRef') return p.ref.local;
    return [...this.firstSet(p, 0)].map((k) => k.replace(/^\{[^}]*\}/, '')).join('|') || p.kind;
  }

  once(p, kids, st, path, errors, depth, counters) {
    if (p.kind === 'element') {
      const d = resolveRef(this.model, p);
      const k = kids[st.i];
      const key = `${path}/${k.local}`;
      counters[key] = (counters[key] || 0) + 1;
      const ptr = counters[key] > 1 || (p.max === UNBOUNDED || p.max > 1) ? `${key}[${counters[key]}]` : key;
      st.i += 1;
      if (d) this.element(k, d, ptr, errors, depth + 1);
      return;
    }
    if (p.kind === 'any') {
      const k = kids[st.i];
      st.i += 1;
      if (p.processContents === 'strict' || p.processContents === 'lax') {
        const g = this.model[k.ns]?.elements[k.local];
        if (g) this.element(k, g, `${path}/${k.local}`, errors, depth + 1);
      }
      return;
    }
    if (p.kind === 'groupRef') {
      const g = findGroup(this.model, p.ref);
      if (g) this.particle({ ...g, min: 1, max: 1 }, kids, st, path, errors, depth + 1, counters);
      else { errors.push({ pointer: path, message: `group ${qkey(p.ref)} is not defined in the schema` }); st.i = kids.length; }
      return;
    }
    if (p.kind === 'sequence') {
      p.items.forEach((it, idx) => this.particle(it, kids, st, path, errors, depth + 1, counters, p.items[idx + 1] || null));
      return;
    }
    if (p.kind === 'choice') {
      const k = kids[st.i];
      const alt = p.items.find((it) => this.matches(it, k, depth + 1));
      if (alt) this.particle(alt, kids, st, path, errors, depth + 1, counters);
      return;
    }
    if (p.kind === 'all') {
      const seen = new Set();
      while (st.i < kids.length) {
        const k = kids[st.i];
        const it = p.items.find((x) => !seen.has(x) && this.matches(x, k, depth + 1));
        if (!it) break;
        seen.add(it);
        this.once(it, kids, st, path, errors, depth + 1, counters);
      }
      for (const it of p.items) if (!seen.has(it) && this.minOf(it, depth + 1) > 0) errors.push({ pointer: `${path}/${this.describe(it)}`, message: 'required element is missing' });
    }
  }
}

const truncate = (s) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

// ---------------------------------------------------------------- samples
const SAMPLE_HINTS = [
  [/e-?mail/i, () => 'jane.doe@example.com'], [/phone|mobile/i, () => '+1-555-0100'], [/url|uri|href|link/i, () => 'https://example.com/resource'],
  [/country.?code/i, () => 'US'], [/currency/i, () => 'USD'], [/first.?name|given/i, () => 'Jane'], [/last.?name|surname|family/i, () => 'Doe'],
  [/^name$|.name$/i, () => 'Example name'], [/city/i, () => 'Boston'], [/zip|postal/i, () => '02445'], [/description|comment|note/i, () => 'Sample text'],
];

class Sampler {
  // optional: include optional elements (true for "try it", false for minimal run-all requests)
  constructor(model, { vars = {}, maxDepth = 6, optional = true } = {}) {
    this.model = model;
    this.vars = vars;
    this.maxDepth = maxDepth;
    this.optional = optional;
    this.omit = null; // { depth, name }: leave out one element (negative tests)
    this.prefixes = new Map(); // ns -> prefix
  }

  leaf(tag, attrs, value) {
    return value === '' ? `<${tag}${attrs}/>` : `<${tag}${attrs}>${escapeXml(value)}</${tag}>`;
  }

  prefix(ns) {
    if (!ns) return '';
    if (!this.prefixes.has(ns)) this.prefixes.set(ns, `ns${this.prefixes.size + 1}`);
    return this.prefixes.get(ns);
  }

  /** xmlns declarations for every namespace used so far. */
  declarations() {
    return [...this.prefixes].map(([ns, p]) => ` xmlns:${p}="${escapeXml(ns)}"`).join('');
  }

  scalar(flat, name) {
    if (this.vars[name] !== undefined) return String(this.vars[name]);
    if (flat.list) return this.scalar(flattenSimple(this.model, flat.item), name);
    if (flat.union) return flat.members.length ? this.scalar(flattenSimple(this.model, flat.members[0]), name) : 'value';
    const f = flat.facets || {};
    if (f.enumeration?.length) return f.enumeration[0];
    if (f.pattern?.length) {
      const v = fromPattern(f.pattern[0], f.minLength ?? f.length, f.maxLength ?? f.length);
      if (!checkSimple(this.model, flat, v)) return v;
    }
    const b = flat.builtin || 'string';
    let v;
    if (b === 'boolean') v = 'true';
    else if (INT_RANGES[b]) {
      let n = 1;
      if (f.minInclusive !== undefined) n = Math.max(n, Number(f.minInclusive));
      if (f.minExclusive !== undefined) n = Math.max(n, Number(f.minExclusive) + 1);
      if (f.maxInclusive !== undefined) n = Math.min(n, Number(f.maxInclusive));
      if (INT_RANGES[b][1] !== null && BigInt(n) > INT_RANGES[b][1]) n = Number(INT_RANGES[b][1]);
      if (INT_RANGES[b][0] !== null && BigInt(n) < INT_RANGES[b][0]) n = Number(INT_RANGES[b][0]);
      v = String(n);
    } else if (b === 'decimal') v = f.fractionDigits === 0 ? '10' : '10.50';
    else if (b === 'float' || b === 'double') v = '1.5';
    else if (b === 'date') v = new Date().toISOString().slice(0, 10);
    else if (b === 'dateTime') v = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    else if (b === 'time') v = '12:00:00';
    else if (b === 'duration') v = 'P1D';
    else if (b === 'base64Binary') v = 'aGVsbG8=';
    else if (b === 'hexBinary') v = 'CAFE';
    else if (b === 'anyURI') v = 'https://example.com/resource';
    else if (b === 'gYear') v = String(new Date().getFullYear());
    else {
      const hint = SAMPLE_HINTS.find(([re]) => re.test(name || ''));
      v = hint ? hint[1]() : 'string';
    }
    const len = [...v].length;
    if (f.length !== undefined && len !== f.length) v = 'x'.repeat(f.length);
    else if (f.maxLength !== undefined && len > f.maxLength) v = v.slice(0, f.maxLength);
    else if (f.minLength !== undefined && len < f.minLength) v = v.padEnd(f.minLength, 'x');
    return v;
  }

  /** XML for an element declaration (one occurrence). */
  element(declIn, depth = 0, stack = []) {
    const decl = resolveRef(this.model, declIn);
    if (!decl) return '';
    const p = this.prefix(decl.ns);
    const tag = p ? `${p}:${decl.name}` : decl.name;
    const t = typeOf(this.model, decl);
    if (!t) return this.leaf(tag, '', '?');
    if (decl.fixed !== undefined) return this.leaf(tag, '', decl.fixed);
    if (t.kind === 'builtin') return this.leaf(tag, '', t.name === 'anyType' ? String(this.vars[decl.name] ?? '') : this.scalar({ builtin: t.name, facets: {} }, decl.name));
    if (t.kind === 'simple') return this.leaf(tag, '', this.scalar(flattenSimple(this.model, t), decl.name));
    const typeKey = decl.type ? qkey(decl.type) : null;
    if (typeKey && stack.includes(typeKey)) return `<${tag}/>`;
    const eff = effectiveComplex(this.model, t);
    const attrs = new Validator(this.model).flatAttributes(eff.attributes).filter((a) => a.use === 'required')
      .map((a) => ` ${a.name}="${escapeXml(a.fixed ?? a.default ?? this.scalar(a.type && isXsd(a.type) ? { builtin: a.type.local, facets: {} } : flattenSimple(this.model, findType(this.model, a.type)), a.name))}"`).join('');
    if (eff.simple) return this.leaf(tag, attrs, this.scalar(eff.simple, decl.name));
    if (!eff.content) return `<${tag}${attrs}/>`;
    const inner = this.particle(eff.content, depth + 1, typeKey ? [...stack, typeKey] : stack);
    return inner ? `<${tag}${attrs}>${inner}</${tag}>` : `<${tag}${attrs}/>`;
  }

  particle(p, depth, stack) {
    if (!p) return '';
    const optional = p.min === 0;
    if (optional && depth > this.maxDepth) return '';
    if (p.kind === 'element') {
      if (this.omit && depth === this.omit.depth && (resolveRef(this.model, p) || {}).name === this.omit.name) return '';
      const n = Math.max(p.min, optional && (!this.optional || depth > this.maxDepth - 2) ? 0 : 1);
      return Array.from({ length: n }, () => this.element(p, depth, stack)).join('');
    }
    if (p.kind === 'any') return '';
    if (p.kind === 'groupRef') return this.particle({ ...(findGroup(this.model, p.ref) || { kind: 'sequence', items: [] }), min: p.min, max: p.max }, depth, stack);
    if (optional && !this.optional) return '';
    if (p.kind === 'choice') return p.items.length ? this.particle({ ...p.items[0], min: Math.max(p.items[0].min, p.min ? 1 : 0) }, depth, stack) : '';
    return p.items.map((it) => this.particle(it, depth, stack)).join('');
  }
}

/** Remove the first required child element (for the "missing required element" negative test). */
function firstRequiredChild(model, decl) {
  const t = typeOf(model, resolveRef(model, decl) || decl);
  if (!t || t.kind !== 'complex') return null;
  const eff = effectiveComplex(model, t);
  const walk = (p, depth = 0) => {
    if (!p || depth > 10) return null;
    if (p.kind === 'element') { if (p.min > 0) { const d = resolveRef(model, p); return d ? { name: d.name, ns: d.ns } : null; } return null; }
    if (p.kind === 'groupRef') return p.min > 0 ? walk(findGroup(model, p.ref), depth + 1) : null;
    if (p.kind === 'sequence' || p.kind === 'all') { if (p.min === 0) return null; for (const it of p.items) { const r = walk(it, depth + 1); if (r) return r; } }
    return null;
  };
  return walk(eff.content);
}

module.exports = { addSchema, Validator, Sampler, findElement, findType, typeOf, firstRequiredChild, checkBuiltin, UNBOUNDED };
