'use strict';
// WSDL 1.1 (SOAP 1.1 / 1.2) contract adapter for the tester: load, lint, list operations, build sample
// envelopes from the XSD, send them through the server-side proxy, validate responses and faults,
// and run the whole contract with id chaining and negative tests.
const crypto = require('node:crypto');
const { NS, parseXml, XmlParseError, elements, child, textOf, escapeXml, resolveQName, qkey, prettyXml } = require('../../../../util/xml');
const { HttpError } = require('../../../../util/problem');
const { execute, summarize } = require('../../runner');
const { loadWsdl } = require('./parse');
const { Validator, Sampler, findElement, findType, firstRequiredChild } = require('./xsd');
const { lintWsdl } = require('./lint');
const { passwordDigest, TYPE_TEXT, TYPE_DIGEST } = require('../../../../protocols/soap/wsse');

const ENV_NS = { '1.1': NS.soap11, '1.2': NS.soap12 };
const CT = { '1.1': 'text/xml; charset=utf-8', '1.2': 'application/soap+xml; charset=utf-8' };

// ---------------------------------------------------------------- operations
function buildOperations(model) {
  const ops = [];
  const add = (svcName, port, b) => {
    const pt = model.portTypes[qkey(b.type)];
    for (const [opName, bop] of Object.entries(b.operations)) {
      const id = `${svcName}/${opName}`;
      let op = ops.find((o) => o.id === id);
      if (!op) {
        const ptop = pt?.operations.find((o) => o.name === opName);
        op = { id, service: svcName, name: opName, documentation: ptop?.documentation || '', style: bop.style || b.style || 'document', input: ptop?.input || null, output: ptop?.output || null, faults: ptop?.faults || [], versions: {} };
        ops.push(op);
      }
      if (!op.versions[b.version]) op.versions[b.version] = { port: port?.name || null, binding: b.name, address: port?.address || '', soapAction: bop.soapAction, inputBody: bop.input, outputBody: bop.output };
    }
  };
  for (const svc of model.services) {
    for (const port of svc.ports) {
      const b = model.bindings[qkey(port.binding)];
      if (b && b.version) add(svc.name, port, b);
    }
  }
  if (!ops.length) for (const b of Object.values(model.bindings)) if (b.version) add(b.name, null, b); // bindings without a service
  return ops;
}

function pickVersion(op, pref) {
  if (pref && pref !== 'auto' && op.versions[pref]) return pref;
  return op.versions['1.1'] ? '1.1' : op.versions['1.2'] ? '1.2' : Object.keys(op.versions)[0];
}

const VERB = /^(get|list|find|search|query|read|fetch|retrieve|lookup|create|add|insert|new|submit|register|update|modify|set|change|put|patch|save|edit|delete|remove|cancel|purge)/i;
function phaseOf(name) {
  if (/^(create|add|insert|new|submit|register)/i.test(name)) return 0;
  if (/^(list|search|find|query|getall|browse)/i.test(name)) return 1;
  if (/^(get|read|fetch|retrieve|lookup)/i.test(name)) return 1.5;
  if (/^(delete|remove|cancel|purge)/i.test(name)) return 3;
  return 2;
}
function nounOf(name) {
  let n = name.replace(VERB, '');
  n = n.replace(/ies$/, 'y').replace(/(ss)$/, '$1').replace(/([^s])s$/, '$1');
  return n ? n[0].toLowerCase() + n.slice(1) : '';
}

// Variable lookup for sample values: "<noun>.<field>", "<field>", "<noun>Id" for id fields.
function varLookup(vars, noun) {
  return new Proxy({}, {
    get(_t, name) {
      if (typeof name !== 'string') return undefined;
      if (noun && vars[`${noun}.${name}`] !== undefined) return vars[`${noun}.${name}`];
      if (noun && /^id$/i.test(name) && vars[`${noun}Id`] !== undefined) return vars[`${noun}Id`];
      if (vars[name] !== undefined) return vars[name];
      const m = /^(.+)Id$/.exec(name);
      if (m && vars[`${m[1]}.id`] !== undefined) return vars[`${m[1]}.id`];
      return undefined;
    },
  });
}

// ---------------------------------------------------------------- envelopes
function partDecl(model, part) {
  if (part.element) return findElement(model.schema, part.element) ? { kind: 'element', ref: part.element, min: 1, max: 1 } : null;
  return { kind: 'element', name: part.name, ns: '', type: part.type, min: 1, max: 1 };
}

function bodyParts(model, msgQ, bodyInfo) {
  const msg = msgQ ? model.messages[qkey(msgQ)] : null;
  if (!msg) return [];
  return bodyInfo?.parts ? msg.parts.filter((p) => bodyInfo.parts.includes(p.name)) : msg.parts;
}

function buildEnvelope(model, op, version, { vars = {}, omitFirstRequired = false, optional = true } = {}) {
  const b = op.versions[version];
  const sampler = new Sampler(model.schema, { vars: varLookup(vars, nounOf(op.name)), optional });
  const parts = bodyParts(model, op.input, b.inputBody);
  let body = '';
  let omitted = null;
  if (op.style === 'rpc') {
    const ns = b.inputBody?.namespace || model.targetNamespace;
    const p = sampler.prefix(ns);
    const kept = omitFirstRequired && parts.length ? parts.slice(1) : parts;
    if (omitFirstRequired && parts.length) omitted = parts[0].name;
    const inner = kept.map((pt) => sampler.element({ kind: 'element', name: pt.name, ns: '', type: pt.type || null, typeDef: null, ...(pt.element ? { ref: pt.element } : {}), min: 1, max: 1 })).join('');
    body = inner ? `<${p}:${op.name}>${inner}</${p}:${op.name}>` : `<${p}:${op.name}/>`;
  } else {
    body = parts.map((pt, i) => {
      const decl = partDecl(model, pt);
      if (!decl) return `<!-- part ${escapeXml(pt.name)}: element ${escapeXml(qkey(pt.element))} not found in the schema -->`;
      if (omitFirstRequired && i === 0) {
        const req = firstRequiredChild(model.schema, decl);
        if (req) { omitted = req.name; sampler.omit = { depth: 1, name: req.name }; }
      }
      return sampler.element(decl);
    }).join('');
  }
  const env = `<soapenv:Envelope xmlns:soapenv="${ENV_NS[version]}"${sampler.declarations()}><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
  return { xml: prettyXml(env), omitted };
}

function wsseHeader(auth) {
  const user = escapeXml(auth.username || '');
  let pw;
  if (auth.passwordType === 'digest') {
    const nonce = crypto.randomBytes(16).toString('base64');
    const created = new Date().toISOString();
    pw = `<wsse:Password Type="${TYPE_DIGEST}">${passwordDigest(nonce, created, auth.password || '')}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce}</wsse:Nonce><wsu:Created>${created}</wsu:Created>`;
  } else pw = `<wsse:Password Type="${TYPE_TEXT}">${escapeXml(auth.password || '')}</wsse:Password>`;
  return `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}"><wsse:UsernameToken><wsse:Username>${user}</wsse:Username>${pw}</wsse:UsernameToken></wsse:Security>`;
}

// Insert a WS-Security header into an envelope string (keeps whatever prefixes the envelope uses).
function injectWsse(xml, auth) {
  const sec = wsseHeader(auth);
  const selfClosing = /<([A-Za-z_][\w.-]*:)?Header(\s[^>]*)?\/>/;
  if (selfClosing.test(xml)) return xml.replace(selfClosing, (m, p = '', a = '') => `<${p}Header${a}>${sec}</${p}Header>`);
  const open = /<([A-Za-z_][\w.-]*:)?Header(\s[^>]*)?>/;
  if (open.test(xml)) return xml.replace(open, (m) => `${m}${sec}`);
  const body = /<([A-Za-z_][\w.-]*:)?Body(\s[^>]*)?>/;
  return xml.replace(body, (m, p = '') => `<${p}Header>${sec}</${p}Header>${m}`);
}

// ---------------------------------------------------------------- response analysis
function parseFault(faultEl, version) {
  if (version === '1.2' || faultEl.ns === NS.soap12) {
    const code = child(faultEl, 'Code', NS.soap12);
    const value = textOf(child(code, 'Value', NS.soap12));
    const sub = textOf(child(child(code, 'Subcode', NS.soap12), 'Value', NS.soap12));
    const reason = textOf(child(child(faultEl, 'Reason', NS.soap12), 'Text', NS.soap12));
    const detail = child(faultEl, 'Detail', NS.soap12);
    const q = resolveQName(code ? child(code, 'Value', NS.soap12) : faultEl, value);
    return { code: value, subcode: sub, reason, detail, local: q?.local || value, structural: !!(code && value && reason) };
  }
  const fc = child(faultEl, 'faultcode');
  const code = textOf(fc);
  const q = resolveQName(fc || faultEl, code);
  return { code, reason: textOf(child(faultEl, 'faultstring')), detail: child(faultEl, 'detail'), local: q?.local || code, structural: !!(fc && code && child(faultEl, 'faultstring')) };
}

const CLIENT_FAULT = /^(Client|Sender)(\.|$)|^(FailedAuthentication|InvalidSecurity|InvalidSecurityToken|FailedCheck|UnsupportedSecurityToken)$/;

/**
 * Validate a SOAP response. Returns { checks, fault, bodyEl }.
 * expect: 'success' | 'fault' | 'any'
 */
function analyze(model, op, version, response, { expect = 'success' } = {}) {
  const checks = [];
  const add = (name, status, message, extra) => checks.push({ name, status, message, ...extra });
  const ct = String(response.headers['content-type'] || '');
  const oneWay = !op.output;

  if (oneWay && expect === 'success') {
    add('http-status', response.status === 202 || response.status === 200 ? 'pass' : 'fail', `One-way operation answered HTTP ${response.status} (expected 202 or 200)`);
    return { checks, fault: null };
  }
  if (!response.size) {
    add('body', 'fail', `Empty response body (HTTP ${response.status})`);
    return { checks, fault: null };
  }
  const expectCt = version === '1.2' ? /^application\/soap\+xml/i : /^text\/xml/i;
  if (expectCt.test(ct)) add('content-type', 'pass', `Content-Type ${ct.split(';')[0]} matches SOAP ${version}`);
  else if (/xml/i.test(ct)) add('content-type', 'warn', `Content-Type "${ct}" is XML but SOAP ${version} uses ${version === '1.2' ? 'application/soap+xml' : 'text/xml'}`);
  else add('content-type', 'fail', `Content-Type "${ct || 'missing'}" is not XML (SOAP ${version} uses ${version === '1.2' ? 'application/soap+xml' : 'text/xml'})`);

  let doc;
  try {
    doc = parseXml(response.body || '');
  } catch (e) {
    add('well-formed', 'fail', `Response is not well-formed XML: ${e instanceof XmlParseError ? e.message : e}`);
    return { checks, fault: null };
  }
  if (doc.local !== 'Envelope' || (doc.ns !== NS.soap11 && doc.ns !== NS.soap12)) {
    add('envelope', 'fail', `Root element is {${doc.ns}}${doc.local}, not a SOAP Envelope`);
    return { checks, fault: null };
  }
  if (doc.ns !== ENV_NS[version]) add('envelope', 'fail', `Response envelope is SOAP ${doc.ns === NS.soap12 ? '1.2' : '1.1'} but the request was SOAP ${version}`);
  else add('envelope', 'pass', `SOAP ${version} envelope`);
  const bodyEl = child(doc, 'Body', doc.ns);
  if (!bodyEl) { add('body', 'fail', 'The Envelope has no Body'); return { checks, fault: null }; }
  const kids = elements(bodyEl);
  const faultEl = kids.find((k) => k.local === 'Fault' && k.ns === doc.ns);

  if (faultEl) {
    const f = parseFault(faultEl, doc.ns === NS.soap12 ? '1.2' : '1.1');
    f.client = CLIENT_FAULT.test(f.local) || /^Client|^Sender/.test(f.local);
    const desc = `${f.code}${f.subcode ? ` / ${f.subcode}` : ''}: ${f.reason || '(no reason)'}`;
    add('fault-structure', f.structural ? 'pass' : 'fail', f.structural ? 'Fault has a code and a reason' : (version === '1.2' ? 'SOAP 1.2 Fault needs Code/Value and Reason/Text' : 'SOAP 1.1 Fault needs faultcode and faultstring'));
    // HTTP status rules from the SOAP bindings
    const okStatus = version === '1.2' ? (f.client ? [400] : [500]) : [500];
    const transport = [401, 403, 404, 405, 413, 415, 429, 503].includes(response.status);
    if (okStatus.includes(response.status)) add('fault-http-status', 'pass', `Fault returned with HTTP ${response.status}`);
    else add('fault-http-status', transport ? 'pass' : 'warn', transport ? `Fault returned with transport status HTTP ${response.status}` : `SOAP ${version} ${f.client ? 'client' : 'server'} faults should use HTTP ${okStatus.join(' or ')}, got ${response.status}`);
    if (expect === 'success') add('no-fault', 'fail', `The service returned a SOAP fault — ${desc}`);
    // Declared fault details
    const detailKids = elements(f.detail);
    if (detailKids.length && op.faults.length) {
      const v = new Validator(model.schema);
      for (const dk of detailKids) {
        const decl = op.faults.map((fl) => model.messages[qkey(fl.message)]?.parts[0]?.element).filter(Boolean).find((q) => q.ns === dk.ns && q.local === dk.local);
        if (!decl) continue;
        const errors = [];
        v.element(dk, findElement(model.schema, decl), `/Fault/detail/${dk.local}`, errors);
        add(`fault-detail:${dk.local}`, errors.length ? 'fail' : 'pass', errors.length ? `${errors.length} schema violation(s) in the declared fault detail` : `Fault detail ${dk.local} matches the WSDL`, errors.length ? { errors: errors.slice(0, 50) } : undefined);
      }
    }
    return { checks, fault: f, bodyEl };
  }

  if (expect === 'fault') add('expect-fault', 'fail', `Expected a SOAP fault, got a normal ${kids[0]?.local || 'empty'} response (HTTP ${response.status})`);
  add('http-status', response.status === 200 ? 'pass' : 'warn', `HTTP ${response.status}${response.status === 200 ? '' : ' (SOAP responses normally use 200)'}`);

  const b = op.versions[version];
  const parts = bodyParts(model, op.output, b?.outputBody);
  const v = new Validator(model.schema);
  if (op.style === 'rpc') {
    const ns = b?.outputBody?.namespace || model.targetNamespace;
    const wrapper = kids[0];
    const want = `${op.name}Response`;
    if (!wrapper || wrapper.local !== want || wrapper.ns !== ns) {
      add('body-element', 'fail', `Expected the rpc wrapper {${ns}}${want}, got ${wrapper ? `{${wrapper.ns}}${wrapper.local}` : 'nothing'}`);
      return { checks, fault: null, bodyEl };
    }
    add('body-element', 'pass', `Response wrapper ${want}`);
    const errors = [];
    const partKids = elements(wrapper);
    for (const pt of parts) {
      const k = partKids.find((x) => x.local === pt.name);
      if (!k) { errors.push({ pointer: `/${want}/${pt.name}`, message: 'part is missing' }); continue; }
      v.element(k, pt.element ? findElement(model.schema, pt.element) || { kind: 'element', name: pt.name, ns: '', type: { ns: NS.xsd, local: 'anyType' } } : { kind: 'element', name: pt.name, ns: '', type: pt.type, min: 1, max: 1 }, `/${want}/${pt.name}`, errors);
    }
    add('body-schema', errors.length ? 'fail' : 'pass', errors.length ? `${errors.length} schema violation${errors.length > 1 ? 's' : ''}` : 'Response matches the WSDL schema', errors.length ? { errors: errors.slice(0, 50) } : undefined);
    return { checks, fault: null, bodyEl };
  }

  const errors = [];
  parts.forEach((pt, i) => {
    const k = kids[i];
    if (!pt.element) {
      if (!k) errors.push({ pointer: `/${pt.name}`, message: 'part is missing' });
      else v.element(k, { kind: 'element', name: pt.name, ns: '', type: pt.type, min: 1, max: 1 }, `/${k.local}`, errors);
      return;
    }
    const want = pt.element;
    if (!k || k.local !== want.local || k.ns !== want.ns) {
      add('body-element', 'fail', `Expected body element {${want.ns}}${want.local}, got ${k ? `{${k.ns}}${k.local}` : 'nothing'}`);
      return;
    }
    add('body-element', 'pass', `Body element ${want.local}`);
    const decl = findElement(model.schema, want);
    if (!decl) errors.push({ pointer: `/${k.local}`, message: `element ${qkey(want)} is not defined in the schema` });
    else v.element(k, decl, `/${k.local}`, errors);
  });
  if (kids.length > parts.length) errors.push({ pointer: `/${kids[parts.length].local}`, message: 'unexpected extra element in the Body' });
  if (parts.length) add('body-schema', errors.length ? 'fail' : 'pass', errors.length ? `${errors.length} schema violation${errors.length > 1 ? 's' : ''}` : 'Response matches the WSDL schema', errors.length ? { errors: errors.slice(0, 50) } : undefined);
  return { checks, fault: null, bodyEl };
}

// Capture id-like leaf values from a response body for later requests.
function captureVars(bodyEl, vars, { override }) {
  const set = (k, v) => { if (v === '' || v === undefined) return; if (override || vars[k] === undefined) vars[k] = v; };
  const seen = new Set();
  const walk = (el, parent, depth) => {
    if (!el || depth > 8) return;
    const kids = elements(el);
    if (!kids.length) {
      if (/^id$|Id$|ID$|Number$|Code$/.test(el.local)) {
        const k = parent ? `${parent}.${el.local}` : el.local;
        if (seen.has(k)) return;
        seen.add(k);
        set(k, textOf(el));
        if (!seen.has(el.local)) { seen.add(el.local); set(el.local, textOf(el)); }
      }
      return;
    }
    for (const k of kids) walk(k, el.local, depth + 1);
  };
  for (const k of elements(bodyEl)) walk(k, null, 0);
}

// ---------------------------------------------------------------- adapter
class WsdlAdapter {
  constructor(ctx) {
    this.ctx = ctx;
    this.kind = 'wsdl';
    this.label = 'WSDL';
    this.cache = new Map();
  }

  detect(text) { return /^\s*(﻿)?</.test(String(text || '')); }

  async load({ content, url }) {
    const { model, notes, title, raw } = await loadWsdl({ content, url });
    const ops = buildOperations(model);
    const versions = [...new Set(ops.flatMap((o) => Object.keys(o.versions)))].sort();
    const first = ops.find((o) => o.versions['1.1']) || ops[0];
    const endpoint = first ? first.versions[pickVersion(first, 'auto')].address : '';
    return {
      doc: model,
      raw,
      title,
      apiVersion: '',
      version: 'WSDL 1.1',
      originalVersion: 'wsdl-1.1',
      converted: false,
      notes: [...notes, `SOAP ${versions.join(' and ') || '(no SOAP binding)'} · ${ops.length} operation${ops.length === 1 ? '' : 's'}`],
      structural: [],
      defaultTarget: { baseUrl: endpoint, soapVersion: 'auto' },
      options: {},
    };
  }

  invalidate(specId) { for (const k of [...this.cache.keys()]) if (k.startsWith(`${specId}|`)) this.cache.delete(k); }

  ops(spec) {
    const key = `${spec.id}|${spec.updatedAt}`;
    if (!this.cache.has(key)) this.cache.set(key, buildOperations(spec.doc));
    return this.cache.get(key);
  }

  lint(spec) { return lintWsdl(spec, buildOperations(spec.doc)); }

  operationCount(spec) { return this.ops(spec).length; }

  operations(spec) {
    return this.ops(spec).map((o) => ({
      id: o.id, method: 'post', path: o.service, operationId: o.name, summary: o.documentation, tags: [o.service], deprecated: false,
      hasBody: true, secured: false, responses: [], soap: { versions: Object.keys(o.versions).sort(), style: o.style, faults: o.faults.map((f) => f.name) },
    }));
  }

  op(spec, opId) {
    const op = this.ops(spec).find((o) => o.id === opId || o.name === opId);
    if (!op) throw new HttpError(404, `Operation ${opId} not found in the WSDL`);
    return op;
  }

  endpoint(spec, op, version, target) {
    return String(target?.baseUrl || op.versions[version]?.address || '').trim();
  }

  makeRequest(spec, op, { version, vars, omitFirstRequired, optional = true } = {}) {
    const v = version || pickVersion(op, spec.target?.soapVersion);
    const b = op.versions[v];
    const action = b.soapAction || '';
    const { xml, omitted } = buildEnvelope(spec.doc, op, v, { vars, omitFirstRequired, optional });
    const params = [];
    if (v === '1.1') params.push({ in: 'header', name: 'SOAPAction', value: `"${action}"`, required: true, enabled: true, description: 'SOAP 1.1 action from the WSDL binding', schema: {} });
    params.push({ in: 'header', name: 'Accept', value: v === '1.2' ? 'application/soap+xml, text/xml;q=0.9' : 'text/xml, application/soap+xml;q=0.9', required: false, enabled: true, description: '', schema: {} });
    return {
      opId: op.id, kind: 'soap', soapVersion: v, endpoint: b.address, params,
      contentType: v === '1.2' ? `${CT['1.2']}${action ? `; action="${action}"` : ''}` : CT['1.1'],
      body: xml, multipart: null, binary: null, examples: [], exampleName: 'generated from the WSDL schema', omitted,
    };
  }

  defaultRequest(spec, opId, _exampleName, { version } = {}) {
    const op = this.op(spec, opId);
    return this.makeRequest(spec, op, { version: version && op.versions[version] ? version : undefined });
  }

  async exec(spec, op, request, target, { noAuth = false, vars = {} } = {}) {
    const version = request.soapVersion || pickVersion(op, target?.soapVersion);
    const t = { ...target, baseUrl: this.endpoint(spec, op, version, target) };
    let body = request.body;
    if (!noAuth && target?.auth?.type === 'wsse' && typeof body === 'string') body = injectWsse(body, target.auth);
    const pseudo = { method: 'post', path: '', security: undefined };
    const r = await execute(this.ctx, spec, pseudo, { ...request, body }, t, { vars, noAuth });
    if (r.request) r.request.method = 'POST';
    return { ...r, version };
  }

  async send(spec, { opId, request, target }) {
    const op = this.op(spec, opId);
    const t = { ...spec.target, ...(target || {}) };
    const req = request || this.makeRequest(spec, op);
    const r = await this.exec(spec, op, req, t);
    const checks = r.error ? r.checks : analyze(spec.doc, op, r.version, r.response).checks;
    const outcome = summarize(checks);
    if (r.response) delete r.response.json;
    return { opId: op.id, ...r, checks, outcome, pass: outcome !== 'fail' };
  }

  async run(spec, { target, negative = false, variables = {}, operationIds }) {
    const all = this.ops(spec);
    const ops = all.filter((o) => !operationIds || !operationIds.length || operationIds.includes(o.id))
      .sort((a, b) => phaseOf(a.name) - phaseOf(b.name));
    const vars = {};
    const manual = { ...(variables || {}) };
    const steps = [];
    const authOn = target?.auth && target.auth.type && target.auth.type !== 'none';
    const push = (step, checks) => { const outcome = summarize(checks); if (step.response) delete step.response.json; steps.push({ ...step, checks, outcome, pass: outcome !== 'fail' }); };
    let malformedDone = false;

    for (const op of ops) {
      const phase = phaseOf(op.name);
      // Run-all sends minimal requests (required elements only) so unknown business rules on optional fields don't fail the run.
      const req = this.makeRequest(spec, op, { vars: { ...vars, ...manual }, optional: false });
      const r = await this.exec(spec, op, req, target);
      let checks = r.checks;
      if (!r.error) {
        const a = analyze(spec.doc, op, r.version, r.response, { expect: 'success' });
        checks = a.checks;
        if (!a.fault && a.bodyEl) captureVars(a.bodyEl, vars, { override: phase === 0 });
      }
      push({ kind: 'positive', opId: op.id, operationId: op.name, phase, ...r }, checks);

      if (!negative) continue;

      if (authOn) {
        const nr = await this.exec(spec, op, req, target, { noAuth: true });
        let nchecks = nr.checks;
        if (!nr.error) {
          const st = nr.response.status;
          const a = analyze(spec.doc, op, nr.version, nr.response, { expect: 'any' });
          nchecks = [];
          if (st === 401) nchecks.push({ name: 'expect-401', status: 'pass', message: 'Request without credentials rejected with 401' });
          else if (st === 403 || a.fault) nchecks.push({ name: 'expect-401', status: 'warn', message: a.fault ? `Rejected with a SOAP fault (HTTP ${st}) rather than 401` : 'Rejected with 403 rather than 401' });
          else nchecks.push({ name: 'expect-401', status: 'fail', message: `Expected the request without credentials to be rejected, got HTTP ${st}` });
          nchecks.push(...a.checks.filter((c) => c.name === 'fault-structure' || c.name === 'well-formed' || c.name === 'envelope'));
        }
        push({ kind: 'negative', test: 'no-auth', opId: op.id, operationId: op.name, ...nr }, nchecks);
      }

      const bad = this.makeRequest(spec, op, { vars: { ...vars, ...manual }, omitFirstRequired: true, optional: false });
      if (bad.omitted) {
        const nr = await this.exec(spec, op, bad, target);
        let nchecks = nr.checks;
        if (!nr.error) {
          const a = analyze(spec.doc, op, nr.version, nr.response, { expect: 'fault' });
          nchecks = a.checks.filter((c) => c.name !== 'expect-fault');
          if (!a.fault) nchecks.push({ name: 'expect-client-fault', status: nr.response.status === 400 ? 'warn' : 'fail', message: `Expected a client fault when <${bad.omitted}> is missing, got HTTP ${nr.response.status} without a fault` });
          else nchecks.push({ name: 'expect-client-fault', status: a.fault.client ? 'pass' : 'warn', message: a.fault.client ? `Missing <${bad.omitted}> rejected with ${a.fault.code}` : `Missing <${bad.omitted}> was reported as a server fault (${a.fault.code}); it is a client error` });
        }
        push({ kind: 'negative', test: 'missing-element', removed: bad.omitted, opId: op.id, operationId: op.name, ...nr }, nchecks);
      }

      if (phase === 1.5) {
        const idVars = {};
        const noun = nounOf(op.name);
        for (const k of ['id', `${noun}Id`]) idVars[k] = '999999937';
        idVars[`${noun}.id`] = '999999937';
        const unk = this.makeRequest(spec, op, { vars: { ...vars, ...manual, ...idVars }, optional: false });
        if (unk.body.includes('999999937')) {
          const nr = await this.exec(spec, op, unk, target);
          let nchecks = nr.checks;
          if (!nr.error) {
            const a = analyze(spec.doc, op, nr.version, nr.response, { expect: 'fault' });
            nchecks = a.checks.filter((c) => c.name !== 'expect-fault');
            nchecks.push(a.fault
              ? { name: 'expect-fault', status: 'pass', message: `Unknown id rejected with ${a.fault.code}${a.fault.subcode ? ` / ${a.fault.subcode}` : ''}` }
              : { name: 'expect-fault', status: 'fail', message: `Expected a fault for an unknown id, got HTTP ${nr.response.status}` });
          }
          push({ kind: 'negative', test: 'unknown-id', opId: op.id, operationId: op.name, ...nr }, nchecks);
        }
      }

      if (!malformedDone) {
        malformedDone = true;
        const broken = { ...req, body: req.body.slice(0, Math.max(10, req.body.length - 25)) };
        const nr = await this.exec(spec, op, broken, target);
        let nchecks = nr.checks;
        if (!nr.error) {
          const a = analyze(spec.doc, op, nr.version, nr.response, { expect: 'fault' });
          nchecks = a.checks.filter((c) => c.name !== 'expect-fault' && c.name !== 'fault-detail');
          if (a.fault) nchecks.push({ name: 'expect-client-fault', status: a.fault.client ? 'pass' : 'warn', message: a.fault.client ? `Malformed XML rejected with ${a.fault.code}` : `Malformed XML was reported as a server fault (${a.fault.code}); it is a client error` });
          else nchecks.push({ name: 'expect-client-fault', status: nr.response.status === 400 ? 'pass' : 'fail', message: nr.response.status === 400 ? 'Malformed XML rejected with HTTP 400' : `Expected malformed XML to be rejected, got HTTP ${nr.response.status}` });
        }
        push({ kind: 'negative', test: 'malformed-xml', opId: op.id, operationId: op.name, ...nr }, nchecks);
      }
    }
    const summary = {
      total: steps.length,
      passed: steps.filter((s) => s.outcome === 'pass').length,
      warned: steps.filter((s) => s.outcome === 'warn').length,
      failed: steps.filter((s) => s.outcome === 'fail').length,
    };
    return { steps, summary, variables: { ...vars, ...manual }, options: {} };
  }

  profiles() {
    return [
      { type: 'none', label: 'None' },
      { type: 'basic', label: 'HTTP Basic', username: '', password: '' },
      { type: 'bearer', label: 'Bearer token', token: '' },
      { type: 'apikey', label: 'API key header', in: 'header', name: 'X-API-Key', value: '' },
      { type: 'oauth2cc', label: 'OAuth2 client credentials', tokenUrl: '', clientId: '', clientSecret: '', scopes: '', clientAuth: 'basic' },
      { type: 'wsse', label: 'WS-Security UsernameToken', username: '', password: '', passwordType: 'text' },
    ];
  }

  async mock() { throw new HttpError(400, 'Mock from spec is available for OpenAPI specs only. To rehearse a SOAP run, load "This tool (live SOAP WSDL)" or point the target at your own service.', { code: 'mock-not-supported' }); }

  async unmock() { return 0; }

  document(spec) { return { contentType: 'text/xml; charset=utf-8', body: spec.raw || '' }; }
}

module.exports = { WsdlAdapter, buildOperations, buildEnvelope, analyze, injectWsse, nounOf, phaseOf };
