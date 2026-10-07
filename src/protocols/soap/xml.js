'use strict';
// Minimal namespace-aware XML DOM on top of saxes (a strict, spec-conformant streaming parser).
// Only what SOAP needs: elements, attributes, text. DOCTYPE is rejected (no entity expansion, no XXE).
const { SaxesParser } = require('saxes');

const NS = {
  soap11: 'http://schemas.xmlsoap.org/soap/envelope/',
  soap12: 'http://www.w3.org/2003/05/soap-envelope',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  xsd: 'http://www.w3.org/2001/XMLSchema',
  wsdl: 'http://schemas.xmlsoap.org/wsdl/',
  wsdlSoap11: 'http://schemas.xmlsoap.org/wsdl/soap/',
  wsdlSoap12: 'http://schemas.xmlsoap.org/wsdl/soap12/',
  http: 'http://schemas.xmlsoap.org/soap/http',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  faults: 'urn:api-test-tool:faults',
};

class XmlParseError extends Error {}

// Returns the root element: { name, local, prefix, ns, attrs: [{name, local, prefix, ns, value}], children: [], text }
// children holds element nodes only; text is the concatenated character data directly inside the element.
function parseXml(input) {
  const parser = new SaxesParser({ xmlns: true, position: true });
  const stack = [];
  let root = null;
  let firstError = null;

  parser.on('error', (e) => { if (!firstError) firstError = e; });
  parser.on('doctype', () => { if (!firstError) firstError = new XmlParseError('DOCTYPE declarations are not allowed'); });
  parser.on('opentag', (node) => {
    const el = {
      name: node.name,
      local: node.local,
      prefix: node.prefix,
      ns: node.uri || '',
      attrs: Object.values(node.attributes || {}).map((a) => ({ name: a.name, local: a.local, prefix: a.prefix, ns: a.uri || '', value: a.value })),
      children: [],
      text: '',
    };
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
    if (!firstError) firstError = e;
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

function escapeXml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
    // Characters that are not allowed in XML 1.0 at all.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

module.exports = { NS, parseXml, XmlParseError, elements, child, attr, textOf, isNil, escapeXml };
