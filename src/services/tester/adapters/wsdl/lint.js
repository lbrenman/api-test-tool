'use strict';
// "Spec lint" for WSDL 1.1: problems that break testing, client generation or interoperability.
const { NS, qkey } = require('../../../../util/xml');

const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost)$|\.invalid$/i;
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// Every QName a schema component refers to: [{ q, where, what }]
function schemaRefs(model) {
  const refs = [];
  const walkParticle = (p, where, depth = 0) => {
    if (!p || depth > 30) return;
    if (p.kind === 'element') {
      if (p.ref) refs.push({ q: p.ref, where, what: 'element' });
      if (p.type) refs.push({ q: p.type, where: `${where}/${p.name}`, what: 'type' });
      if (p.typeDef) walkType(p.typeDef, `${where}/${p.name}`, depth + 1);
      return;
    }
    if (p.kind === 'groupRef') { refs.push({ q: p.ref, where, what: 'group' }); return; }
    for (const it of p.items || []) walkParticle(it, where, depth + 1);
  };
  const walkAttrs = (list, where) => {
    for (const a of list || []) {
      if (a.groupRef) refs.push({ q: a.groupRef, where, what: 'attributeGroup' });
      else if (a.type) refs.push({ q: a.type, where: `${where}/@${a.name}`, what: 'type' });
    }
  };
  const walkType = (t, where, depth = 0) => {
    if (!t || depth > 30) return;
    if (t.kind === 'simple') {
      if (t.base) refs.push({ q: t.base, where, what: 'type' });
      if (t.list) refs.push({ q: t.list, where, what: 'type' });
      for (const m of t.union || []) refs.push({ q: m, where, what: 'type' });
      if (t.baseInline) walkType(t.baseInline, where, depth + 1);
      return;
    }
    if (t.base) refs.push({ q: t.base, where, what: 'type' });
    walkParticle(t.content, where, depth + 1);
    walkAttrs(t.attributes, where);
  };
  for (const [ns, b] of Object.entries(model.schema)) {
    for (const [name, d] of Object.entries(b.elements)) walkParticle(d, `{${ns}}${name}`);
    for (const [name, t] of Object.entries(b.types)) walkType(t, `{${ns}}${name}`);
    for (const [name, g] of Object.entries(b.groups)) walkParticle(g, `{${ns}}${name}`);
  }
  return refs;
}

function exists(model, q, what) {
  if (!q) return true;
  if (q.ns === NS.xsd) return true;
  const b = model.schema[q.ns];
  if (!b) return false;
  if (what === 'element') return !!b.elements[q.local];
  if (what === 'group') return !!b.groups[q.local];
  if (what === 'attributeGroup') return !!b.attributeGroups[q.local];
  return !!b.types[q.local];
}

function lintWsdl(spec, ops) {
  const model = spec.doc;
  const issues = [];
  const add = (severity, rule, pointer, message, fix) => issues.push({ severity, rule, pointer, message, fix });

  for (const u of model.unresolved || []) {
    add(u.kind === 'wsdl:import' ? 'error' : 'warning', 'unresolved-import', u.location || u.namespace || '(import)',
      `${u.kind}${u.namespace ? ` of ${u.namespace}` : ''}${u.location ? ` from ${u.location}` : ''} could not be loaded: ${u.reason}.`,
      u.reason.includes('not loaded from a URL') ? 'Load the WSDL by URL so relative locations resolve, or paste a WSDL with the schemas inlined.' : 'Check that the location is reachable from this server.');
  }

  const bindings = Object.values(model.bindings);
  if (!bindings.some((b) => b.version)) add('error', 'no-soap-binding', '/definitions', 'The WSDL has no SOAP 1.1 or SOAP 1.2 binding, so there is nothing to call.', 'Add a wsdl:binding with soap:binding or soap12:binding.');
  if (!model.services.length) add('warning', 'no-service', '/definitions', 'The WSDL defines no wsdl:service, so there is no endpoint address.', 'Set the endpoint URL on the Target tab, or add a service with a port and soap:address.');

  for (const svc of model.services) {
    for (const port of svc.ports) {
      const ptr = `/definitions/service[@name='${svc.name}']/port[@name='${port.name}']`;
      if (!model.bindings[qkey(port.binding)]) add('error', 'unknown-binding', ptr, `Port ${port.name} refers to binding ${qkey(port.binding)}, which is not defined.`);
      if (!port.address) add('warning', 'no-address', ptr, `Port ${port.name} has no soap:address location.`, 'Set the endpoint URL on the Target tab.');
      else if (PLACEHOLDER_HOST.test(hostOf(port.address))) add('warning', 'placeholder-address', ptr, `Port ${port.name} points at a placeholder or local address (${port.address}).`, 'Set the real endpoint URL on the Target tab before sending requests.');
      else if (/^http:/i.test(port.address)) add('info', 'plain-http', ptr, `Port ${port.name} uses plain HTTP (${port.address}).`);
    }
  }

  for (const b of bindings) {
    const ptr = `/definitions/binding[@name='${b.name}']`;
    const pt = model.portTypes[qkey(b.type)];
    if (!pt) { add('error', 'unknown-port-type', ptr, `Binding ${b.name} refers to portType ${qkey(b.type)}, which is not defined.`); continue; }
    if (!b.version) continue;
    if (b.transport && b.transport !== NS.http) add('warning', 'transport', ptr, `Binding ${b.name} uses transport ${b.transport}; only HTTP (${NS.http}) can be tested here.`);
    const names = pt.operations.map((o) => o.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) add('warning', 'overloaded-operation', `/definitions/portType[@name='${pt.name}']`, `Operation name(s) ${[...new Set(dup)].join(', ')} are overloaded; WS-I Basic Profile forbids this and many clients cannot handle it.`);
    for (const [opName, bop] of Object.entries(b.operations)) {
      const optr = `${ptr}/operation[@name='${opName}']`;
      const ptop = pt.operations.find((o) => o.name === opName);
      if (!ptop) { add('error', 'binding-operation-not-in-port-type', optr, `Binding operation ${opName} has no matching portType operation.`); continue; }
      const style = bop.style || b.style;
      for (const [dir, io] of [['input', bop.input], ['output', bop.output]]) {
        if (!io) continue;
        if (io.use === 'encoded') add('error', 'soap-encoding', optr, `${opName} ${dir} uses use="encoded" (SOAP encoding). Only literal messages can be generated and validated.`, 'Use document/literal (or rpc/literal).');
        if (io.headers.length) add('info', 'soap-header-parts', optr, `${opName} ${dir} declares soap:header parts (${io.headers.map((h) => h.part).join(', ')}); they are not generated automatically.`, 'Add the header blocks to the envelope on the Try it tab.');
        const msgQ = dir === 'input' ? ptop.input : ptop.output;
        const msg = msgQ ? model.messages[qkey(msgQ)] : null;
        if (msgQ && !msg) { add('error', 'unknown-message', optr, `${opName} ${dir} message ${qkey(msgQ)} is not defined.`); continue; }
        if (!msg) continue;
        const parts = io.parts ? msg.parts.filter((p) => io.parts.includes(p.name)) : msg.parts;
        if (style === 'document') {
          if (parts.length > 1) add('warning', 'multiple-body-parts', optr, `${opName} ${dir} has ${parts.length} body parts in document style; WS-I allows at most one.`);
          for (const p of parts) if (!p.element) add('warning', 'document-type-part', optr, `${opName} ${dir} part ${p.name} uses type= in document style; WS-I requires element=.`);
        } else {
          for (const p of parts) if (p.element) add('warning', 'rpc-element-part', optr, `${opName} ${dir} part ${p.name} uses element= in rpc style; WS-I requires type=.`);
          if (!io.namespace) add('warning', 'rpc-namespace', optr, `${opName} ${dir} is rpc style without soap:body namespace; the wrapper element's namespace is ambiguous.`);
        }
        for (const p of parts) {
          if (p.element && !exists(model, p.element, 'element')) add('error', 'unknown-element', optr, `${opName} ${dir} part ${p.name} refers to element ${qkey(p.element)}, which is not defined in the schema.`);
          if (p.type && !exists(model, p.type, 'type')) add('error', 'unknown-type', optr, `${opName} ${dir} part ${p.name} refers to type ${qkey(p.type)}, which is not defined in the schema.`);
        }
      }
      if (b.version === '1.1' && bop.soapAction === null) add('info', 'no-soap-action', optr, `${opName} has no soapAction; SOAP 1.1 clients will send SOAPAction: "".`);
      for (const f of ptop.faults) {
        const fm = model.messages[qkey(f.message)];
        if (!fm) add('error', 'unknown-fault-message', optr, `Fault ${f.name} of ${opName} refers to message ${qkey(f.message)}, which is not defined.`);
        else if (fm.parts.length !== 1 || !fm.parts[0].element) add('warning', 'fault-part', optr, `Fault message ${fm.name} should have exactly one part with element=.`);
      }
    }
  }

  for (const r of schemaRefs(model)) {
    if (!exists(model, r.q, r.what)) add('error', `undefined-${r.what === 'element' ? 'element' : r.what === 'group' ? 'group' : 'type'}`, r.where, `${r.what} ${qkey(r.q)} used by ${r.where} is not defined in any loaded schema.`, 'Inline the missing schema, fix the namespace prefix, or load the WSDL by URL so imports resolve.');
  }
  for (const s of model.schemaInfo || []) {
    if (s.elementForm !== 'qualified' && Object.keys(model.schema[s.tns]?.types || {}).length) {
      add('info', 'unqualified-locals', `{${s.tns}}`, `Schema ${s.tns || '(no namespace)'} uses elementFormDefault="unqualified": local elements are in no namespace. Generated requests follow that, but some clients get it wrong.`);
    }
  }
  if (!ops.length && bindings.some((b) => b.version)) add('warning', 'no-operations', '/definitions', 'The SOAP bindings define no operations.');

  const seen = new Set();
  const out = issues.filter((i) => { const k = `${i.rule}|${i.pointer}|${i.message}`; return seen.has(k) ? false : seen.add(k); });
  const order = { error: 0, warning: 1, info: 2 };
  out.sort((x, y) => order[x.severity] - order[y.severity]);
  return {
    issues: out,
    counts: { error: out.filter((i) => i.severity === 'error').length, warning: out.filter((i) => i.severity === 'warning').length, info: out.filter((i) => i.severity === 'info').length },
  };
}

module.exports = { lintWsdl };
