'use strict';
// Parse a WSDL 1.1 document (plus wsdl:import and xsd:import/include with a location) into a
// JSON-serialisable contract model used by the WSDL tester adapter.
const { NS, parseXml, XmlParseError, elements, child, attr, textOf, resolveQName, qkey } = require('../../../../util/xml');
const { addSchema } = require('./xsd');

const WSDL20 = 'http://www.w3.org/ns/wsdl';
const MAX_DOCS = 25;

class WsdlError extends Error {
  constructor(message) { super(message); this.status = 422; }
}

async function fetchText(url) {
  let u;
  try { u = new URL(url); } catch { throw new WsdlError(`Invalid URL ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new WsdlError(`Only http(s) locations can be fetched (${url})`);
  const res = await fetch(u, { headers: { Accept: 'text/xml, application/wsdl+xml, application/xml;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new WsdlError(`Fetching ${url} failed: HTTP ${res.status}`);
  return res.text();
}

function parseDoc(text, where) {
  try {
    return parseXml(text);
  } catch (e) {
    if (e instanceof XmlParseError) throw new WsdlError(`${where} is not well-formed XML: ${e.message}`);
    throw e;
  }
}

const documentation = (el) => textOf(child(el, 'documentation', NS.wsdl)) || '';

/**
 * Build the contract model.
 * Returns { model, notes, title }.
 * model = { targetNamespace, name, documentation, schema: {ns: {...}}, schemaInfo: [{tns, elementForm}],
 *           messages: {key: {name, parts}}, portTypes: {key: {name, operations}}, bindings: {key: {...}},
 *           services: [{name, documentation, ports: [{name, binding, address, version}]}], unresolved: [] }
 */
async function loadWsdl({ content, url }) {
  const notes = [];
  const model = { targetNamespace: '', name: '', documentation: '', schema: {}, schemaInfo: [], messages: {}, portTypes: {}, bindings: {}, services: [], unresolved: [] };
  const seenDocs = new Set();
  const seenSchemas = new Set();
  let docs = 0;

  async function loadSchemaRef(ref, baseUrl, fromWhere) {
    if (!ref.location) {
      if (ref.kind === 'import' && ref.namespace && ref.namespace !== NS.xml) model.unresolved.push({ kind: 'xsd:import', namespace: ref.namespace, location: null, from: fromWhere, reason: 'no schemaLocation' });
      return;
    }
    let abs;
    try { abs = new URL(ref.location, baseUrl || undefined).toString(); } catch {
      model.unresolved.push({ kind: `xsd:${ref.kind}`, namespace: ref.namespace, location: ref.location, from: fromWhere, reason: 'relative location and the WSDL was not loaded from a URL' });
      return;
    }
    if (seenSchemas.has(abs)) return;
    seenSchemas.add(abs);
    if (++docs > MAX_DOCS) { model.unresolved.push({ kind: `xsd:${ref.kind}`, location: abs, from: fromWhere, reason: `more than ${MAX_DOCS} documents` }); return; }
    let root;
    try {
      root = parseDoc(await fetchText(abs), abs);
    } catch (e) {
      model.unresolved.push({ kind: `xsd:${ref.kind}`, namespace: ref.namespace, location: abs, from: fromWhere, reason: e.message });
      return;
    }
    if (root.local !== 'schema' || root.ns !== NS.xsd) {
      model.unresolved.push({ kind: `xsd:${ref.kind}`, location: abs, from: fromWhere, reason: 'not an xsd:schema document' });
      return;
    }
    await addSchemaEl(root, abs, ref.kind === 'include' ? ref.namespace : undefined);
    notes.push(`Loaded schema ${abs}`);
  }

  async function addSchemaEl(schemaEl, baseUrl, tnsOverride) {
    const info = addSchema(model.schema, schemaEl, { tnsOverride: attr(schemaEl, 'targetNamespace') === undefined ? tnsOverride : undefined });
    model.schemaInfo.push({ tns: info.tns, elementForm: info.elementForm });
    for (const ref of info.refs) {
      // An import of a namespace defined inline elsewhere in the WSDL needs no location.
      if (ref.kind === 'import' && !ref.location) continue;
      await loadSchemaRef(ref, baseUrl, info.tns);
    }
  }

  async function addWsdl(root, baseUrl) {
    if (root.ns === WSDL20 && root.local === 'description') throw new WsdlError('WSDL 2.0 is not supported; use a WSDL 1.1 document');
    if (root.local !== 'definitions' || root.ns !== NS.wsdl) throw new WsdlError('Not a WSDL 1.1 document: the root element must be wsdl:definitions');
    const tns = attr(root, 'targetNamespace') || '';
    if (!model.targetNamespace) {
      model.targetNamespace = tns;
      model.name = attr(root, 'name') || '';
      model.documentation = documentation(root);
    }
    for (const imp of elements(root, 'import', NS.wsdl)) {
      const loc = attr(imp, 'location');
      if (!loc) continue;
      let abs;
      try { abs = new URL(loc, baseUrl || undefined).toString(); } catch {
        model.unresolved.push({ kind: 'wsdl:import', location: loc, reason: 'relative location and the WSDL was not loaded from a URL' });
        continue;
      }
      if (seenDocs.has(abs)) continue;
      seenDocs.add(abs);
      if (++docs > MAX_DOCS) { model.unresolved.push({ kind: 'wsdl:import', location: abs, reason: `more than ${MAX_DOCS} documents` }); continue; }
      let r;
      try { r = parseDoc(await fetchText(abs), abs); } catch (e) { model.unresolved.push({ kind: 'wsdl:import', location: abs, reason: e.message }); continue; }
      if (r.local === 'schema' && r.ns === NS.xsd) await addSchemaEl(r, abs);
      else await addWsdl(r, abs);
      notes.push(`Loaded imported document ${abs}`);
    }
    for (const types of elements(root, 'types', NS.wsdl)) {
      for (const s of elements(types, 'schema', NS.xsd)) await addSchemaEl(s, baseUrl);
    }
    for (const m of elements(root, 'message', NS.wsdl)) {
      const name = attr(m, 'name');
      model.messages[qkey({ ns: tns, local: name })] = {
        name,
        parts: elements(m, 'part', NS.wsdl).map((p) => ({
          name: attr(p, 'name'),
          element: attr(p, 'element') ? resolveQName(p, attr(p, 'element')) : null,
          type: attr(p, 'type') ? resolveQName(p, attr(p, 'type')) : null,
        })),
      };
    }
    for (const pt of elements(root, 'portType', NS.wsdl)) {
      const name = attr(pt, 'name');
      model.portTypes[qkey({ ns: tns, local: name })] = {
        name,
        operations: elements(pt, 'operation', NS.wsdl).map((o) => ({
          name: attr(o, 'name'),
          documentation: documentation(o),
          input: child(o, 'input', NS.wsdl) ? resolveQName(child(o, 'input', NS.wsdl), attr(child(o, 'input', NS.wsdl), 'message')) : null,
          output: child(o, 'output', NS.wsdl) ? resolveQName(child(o, 'output', NS.wsdl), attr(child(o, 'output', NS.wsdl), 'message')) : null,
          faults: elements(o, 'fault', NS.wsdl).map((f) => ({ name: attr(f, 'name'), message: resolveQName(f, attr(f, 'message')) })),
        })),
      };
    }
    for (const b of elements(root, 'binding', NS.wsdl)) {
      const name = attr(b, 'name');
      const s11 = child(b, 'binding', NS.wsdlSoap11);
      const s12 = child(b, 'binding', NS.wsdlSoap12);
      const sb = s11 || s12;
      const soapNs = s11 ? NS.wsdlSoap11 : NS.wsdlSoap12;
      const bodyInfo = (io) => {
        if (!io) return null;
        const body = child(io, 'body', soapNs);
        return {
          use: attr(body, 'use') || 'literal',
          namespace: attr(body, 'namespace') || '',
          parts: attr(body, 'parts') !== undefined ? String(attr(body, 'parts')).split(/\s+/).filter(Boolean) : null,
          headers: elements(io, 'header', soapNs).map((h) => ({ message: resolveQName(h, attr(h, 'message')), part: attr(h, 'part') })),
        };
      };
      model.bindings[qkey({ ns: tns, local: name })] = {
        name,
        type: resolveQName(b, attr(b, 'type')),
        version: s11 ? '1.1' : s12 ? '1.2' : null,
        transport: attr(sb, 'transport') || '',
        style: attr(sb, 'style') || 'document',
        operations: Object.fromEntries(elements(b, 'operation', NS.wsdl).map((o) => {
          const so = child(o, 'operation', soapNs);
          return [attr(o, 'name'), {
            soapAction: attr(so, 'soapAction') ?? null,
            style: attr(so, 'style') || null,
            input: bodyInfo(child(o, 'input', NS.wsdl)),
            output: bodyInfo(child(o, 'output', NS.wsdl)),
          }];
        })),
      };
    }
    for (const svc of elements(root, 'service', NS.wsdl)) {
      model.services.push({
        name: attr(svc, 'name'),
        documentation: documentation(svc),
        ports: elements(svc, 'port', NS.wsdl).map((p) => {
          const a11 = child(p, 'address', NS.wsdlSoap11);
          const a12 = child(p, 'address', NS.wsdlSoap12);
          return { name: attr(p, 'name'), binding: resolveQName(p, attr(p, 'binding')), address: attr(a11 || a12, 'location') || '', version: a11 ? '1.1' : a12 ? '1.2' : null };
        }),
      });
    }
  }

  let text = content;
  if (!text && url) text = await fetchText(url);
  if (!text || !String(text).trim()) throw new WsdlError('WSDL is empty');
  if (url) seenDocs.add(url);
  await addWsdl(parseDoc(text, 'The WSDL'), url || null);
  return { model, notes, title: model.name || model.services[0]?.name || 'SOAP service', raw: String(text) };
}

module.exports = { loadWsdl, WsdlError, fetchText };
