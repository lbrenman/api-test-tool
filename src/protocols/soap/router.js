'use strict';
// /soap — mock SOAP 1.1 / 1.2 services over the shared mock data.
//
//   GET  /soap                         service list (JSON)
//   GET  /soap/{Service}?wsdl          WSDL (also /soap/{Service}.wsdl) — always open, like /openapi.json
//   POST /soap/{Service}               SOAP request; goes through the shared protocol stack
//                                      (required headers, rate limit, AUTH_MODE, chaos) and SOAP_WSSE
const express = require('express');
const { HttpError, sendProblem } = require('../../util/problem');
const { protocolStack } = require('../../middleware/protocol');
const { verify } = require('../../middleware/body');
const { NS, parseXml, XmlParseError, elements, child, attr } = require('./xml');
const { SERVICES, readParams } = require('./services');
const { generateWsdl } = require('./wsdl');
const { CONTENT_TYPE, envelope, versionFromContentType } = require('./renderer');
const { checkWsse } = require('./wsse');

const XML_TYPES = ['text/xml', 'application/soap+xml', 'application/xml'];

function serviceName(req) {
  return String(req.params.service || '').replace(/\.wsdl$/i, '');
}

function findService(req) {
  const svc = SERVICES[serviceName(req)];
  if (!svc) throw new HttpError(404, `Unknown SOAP service "${serviceName(req)}". Available: ${Object.keys(SERVICES).join(', ')}`, { code: 'unknown-service' });
  return svc;
}

// SOAPAction (1.1 header) or the action parameter of the SOAP 1.2 Content-Type.
function sentAction(req, version) {
  if (version === '1.1') {
    const h = req.get('soapaction');
    return h === undefined ? undefined : h.trim().replace(/^"(.*)"$/, '$1');
  }
  const m = /;\s*action\s*=\s*"?([^";]*)"?/i.exec(req.get('content-type') || '');
  return m ? m[1] : undefined;
}

function checkAction(req, svc, op, version, mode) {
  if (mode === 'off') return;
  const expected = svc.action(op.name);
  const sent = sentAction(req, version);
  const where = version === '1.1' ? 'SOAPAction header' : 'action parameter of the Content-Type';
  if (sent === undefined || sent === '') {
    if (mode === 'strict') throw new HttpError(400, `Missing ${where}; expected "${expected}"`, { code: 'missing-soap-action' });
    return;
  }
  if (sent !== expected) throw new HttpError(400, `The ${where} "${sent}" does not match operation ${op.name}; expected "${expected}"`, { code: 'soap-action-mismatch' });
}

function isTrue(v) { return v === '1' || v === 'true'; }

module.exports = function soapRouter(ctx) {
  const { settings, baseUrl } = ctx;
  const r = express.Router();

  r.use((req, res, next) => {
    req.errorFormat = 'soap';
    if (!settings.get('soapEnabled')) return sendProblem(req, res, 404, { detail: 'The SOAP mock is disabled (SOAP_ENABLED=false)', code: 'soap-disabled' });
    next();
  });

  // ---- open: discovery and WSDL
  r.get('/', (req, res) => {
    const base = baseUrl(req);
    res.json({
      services: Object.values(SERVICES).map((s) => ({
        name: s.name, title: s.title, namespace: s.ns,
        endpoint: `${base}/soap/${s.name}`, wsdl: `${base}/soap/${s.name}?wsdl`,
        operations: s.operations.map((o) => ({ name: o.name, soapAction: s.action(o.name), description: o.doc, sampleBody: `<tns:${o.name}>${o.sample}</tns:${o.name}>` })),
      })),
      versions: ['1.1', '1.2'],
      wsse: settings.get('soapWsse'),
      soapActionCheck: settings.get('soapActionCheck'),
    });
  });

  r.get('/:service', (req, res) => {
    const svc = findService(req);
    const wantsWsdl = 'wsdl' in req.query || 'WSDL' in req.query || /\.wsdl$/i.test(req.params.service);
    if (!wantsWsdl) {
      throw new HttpError(405, `Send SOAP requests with POST. The WSDL is at ${baseUrl(req)}/soap/${svc.name}?wsdl`, { code: 'method-not-allowed', headers: { Allow: 'GET, POST' } });
    }
    res.type('text/xml; charset=utf-8').send(generateWsdl(svc, `${baseUrl(req)}/soap/${svc.name}`));
  });

  // ---- protected: SOAP requests
  const body = express.text({ type: XML_TYPES, limit: '2mb', verify });
  const stack = protocolStack(ctx, { format: 'soap', body });

  r.post('/:service', ...stack, async (req, res) => {
    const svc = findService(req);
    if (typeof req.body !== 'string') {
      throw new HttpError(415, 'Content-Type must be text/xml (SOAP 1.1) or application/soap+xml (SOAP 1.2)', { code: 'unsupported-media-type' });
    }
    const version = versionFromContentType(req);
    req.soap = { version, inEnvelope: true, service: svc.name };

    let doc;
    try {
      doc = parseXml(req.body);
    } catch (e) {
      if (e instanceof XmlParseError) throw new HttpError(400, `Malformed XML: ${e.message}`, { code: 'malformed-xml' });
      throw e;
    }
    const expectedNs = version === '1.2' ? NS.soap12 : NS.soap11;
    if (doc.local !== 'Envelope' || (doc.ns !== NS.soap11 && doc.ns !== NS.soap12)) {
      throw new HttpError(400, `The root element must be a SOAP ${version} Envelope in namespace ${expectedNs}`, { code: 'not-a-soap-envelope' });
    }
    if (doc.ns !== expectedNs) {
      const other = doc.ns === NS.soap12 ? '1.2' : '1.1';
      throw new HttpError(400, `The envelope is SOAP ${other} but the Content-Type is SOAP ${version} (${version === '1.1' ? 'text/xml' : 'application/soap+xml'})`, { code: 'version-mismatch' });
    }

    const header = child(doc, 'Header', expectedNs);
    const bodyEl = child(doc, 'Body', expectedNs);
    if (!bodyEl) throw new HttpError(400, 'The Envelope has no Body', { code: 'missing-body' });

    // Header blocks marked mustUnderstand: only WS-Security is understood (when SOAP_WSSE is not off).
    for (const block of elements(header)) {
      const mu = attr(block, 'mustUnderstand', expectedNs);
      const understood = block.ns === NS.wsse && block.local === 'Security' && settings.get('soapWsse') !== 'off';
      if (isTrue(mu) && !understood) {
        throw new HttpError(400, `Header block {${block.ns}}${block.local} is marked mustUnderstand but is not understood`, { code: 'must-understand' });
      }
    }
    req.soap.user = checkWsse(header, settings);

    const [opEl, ...rest] = elements(bodyEl);
    if (!opEl) throw new HttpError(400, 'The Body is empty; expected one operation element', { code: 'missing-operation' });
    if (rest.length) throw new HttpError(400, 'The Body must contain exactly one operation element', { code: 'multiple-operations' });
    if (opEl.ns !== svc.ns) {
      throw new HttpError(400, `Operation element <${opEl.local}> is in namespace "${opEl.ns}"; expected "${svc.ns}"`, { code: 'wrong-namespace' });
    }
    const op = svc.byName.get(opEl.local);
    if (!op) {
      throw new HttpError(400, `Unknown operation "${opEl.local}". ${svc.name} supports: ${svc.operations.map((o) => o.name).join(', ')}`, { code: 'unknown-operation' });
    }
    req.soap.operation = op.name;
    checkAction(req, svc, op, version, settings.get('soapActionCheck'));

    const params = readParams(opEl, op.input);
    const inner = await op.run(ctx, params);
    res.setHeader('X-Soap-Operation', op.name);
    res.status(200).type(CONTENT_TYPE[version])
      .send(envelope(version, `<tns:${op.name}Response>${inner}</tns:${op.name}Response>`, ` xmlns:tns="${svc.ns}"`));
  });

  r.all('/:service', (req) => {
    findService(req);
    throw new HttpError(405, `${req.method} is not supported; use POST for SOAP requests and GET ?wsdl for the WSDL`, { code: 'method-not-allowed', headers: { Allow: 'GET, POST' } });
  });
  r.use((req) => { throw new HttpError(404, `No SOAP route ${req.method} ${req.originalUrl}`, { code: 'route-not-found' }); });

  return r;
};
