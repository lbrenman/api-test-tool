'use strict';
// Minimal namespace-aware XML DOM on top of saxes (a strict, spec-conformant streaming parser).
// Used by the SOAP mock and the WSDL contract tester. DOCTYPE is rejected (no entity expansion, no XXE).
const { SaxesParser } = require('saxes');

const NS = {
  soap11: 'http://schemas.xmlsoap.org/soap/envelope/',
  soap12: 'http://www.w3.org/2003/05/soap-envelope',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  xsd: 'http://www.w3.org/2001/XMLSchema',
  xml: 'http://www.w3.org/XML/1998/namespace',
  xmlns: 'http://www.w3.org/2000/xmlns/',
  wsdl: 'http://schemas.xmlsoap.org/wsdl/',
  wsdlSoap11: 'http://schemas.xmlsoap.org/wsdl/soap/',
  wsdlSoap12: 'http://schemas.xmlsoap.org/wsdl/soap12/',
  http: 'http://schemas.xmlsoap.org/soap/http',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  faults: 'urn:api-test-tool:faults',
};

class XmlParseError extends Error {}

// Returns the root element:
//   { name, local, prefix, ns, attrs: [{name, local, prefix, ns, value}], children: [], text, scope }
// children holds element nodes only; text is the character data directly inside the element;
// scope maps every in-scope prefix ('' = default namespace) to its namespace URI.
// Namespace declarations (xmlns, xmlns:p) are reflected in scope, not in attrs.
function parseXml(input, { maxDepth = 256 } = {}) {
  const parser = new SaxesParser({ xmlns: true, position: true });
  const stack = [];
  let root = null;
  let firstError = null;
  const fail = (e) => { if (!firstError) firstError = e; };

  parser.on('error', fail);
  parser.on('doctype', () => fail(new XmlParseError('DOCTYPE declarations are not allowed')));
  parser.on('opentag', (node) => {
    const parentScope = stack.length ? stack[stack.length - 1].scope : { xml: NS.xml };
    const all = Object.values(node.attributes || {}).map((a) => ({ name: a.name, local: a.local, prefix: a.prefix, ns: a.uri || '', value: a.value }));
    let scope = parentScope;
    // saxes exposes the bindings declared on a tag as node.ns; xmlns attributes are read as well.
    for (const [p, uri] of Object.entries(node.ns || {})) {
      if (scope === parentScope) scope = { ...parentScope };
      scope[p] = uri;
    }
    for (const a of all) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) {
        if (scope === parentScope) scope = { ...parentScope };
        scope[a.name === 'xmlns' ? '' : a.name.slice(6)] = a.value;
      }
    }
    const el = {
      name: node.name, local: node.local, prefix: node.prefix, ns: node.uri || '',
      attrs: all.filter((a) => a.name !== 'xmlns' && !a.name.startsWith('xmlns:')),
      children: [], text: '', scope,
    };
    if (stack.length >= maxDepth) fail(new XmlParseError(`Nesting deeper than ${maxDepth} levels`));
    if (stack.length) stack[stack.length - 1].children.push(el);
    else if (!root) root = el;
    stack.push(el);
  });
  const addText = (t) => { if (stack.length) stack[stack.length - 1].text += t; };
  parser.on('text', addText);
  parser.on('cdata', addText);
  parser.on('closetag', () => { stack.pop(); });

  try {
    parser.write(String(input)).close();
  } catch (e) {
    fail(e);
  }
  if (firstError) throw new XmlParseError(firstError.message);
  if (!root) throw new XmlParseError('No root element');
  return root;
}

const elements = (el, local, ns) => (el?.children || []).filter((c) => (local === undefined || c.local === local) && (ns === undefined || c.ns === ns));
const child = (el, local, ns) => elements(el, local, ns)[0] || null;
const attr = (el, local, ns) => (el?.attrs || []).find((a) => a.local === local && (ns === undefined || a.ns === ns))?.value;
const textOf = (el) => (el ? el.text.trim() : '');
const isNil = (el) => ['true', '1'].includes(String(attr(el, 'nil', NS.xsi) || '').trim());

/** Resolve a QName value ("tns:Foo" or "Foo") in the scope of an element: { ns, local }. */
function resolveQName(el, value, { defaultNs } = {}) {
  if (!value) return null;
  const v = String(value).trim();
  const i = v.indexOf(':');
  if (i < 0) return { ns: defaultNs !== undefined ? defaultNs : (el?.scope?.[''] || ''), local: v };
  const prefix = v.slice(0, i);
  return { ns: el?.scope?.[prefix] ?? `urn:unresolved-prefix:${prefix}`, local: v.slice(i + 1) };
}

const qkey = (q) => (q ? `{${q.ns || ''}}${q.local}` : '');

function escapeXml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
    // Characters that are not allowed in XML 1.0 at all.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

/** Indent an XML string for display. Not a canonicalizer: text content is kept as-is. */
function prettyXml(xml) {
  let depth = 0;
  return String(xml).replace(/>\s*</g, '>\n<').split('\n').map((line) => {
    if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
    const out = '  '.repeat(depth) + line;
    if (/^<[^!?/][^>]*[^/]>$/.test(line)) depth += 1;
    return out;
  }).join('\n');
}

module.exports = { NS, parseXml, XmlParseError, elements, child, attr, textOf, isNil, escapeXml, resolveQName, qkey, prettyXml };
