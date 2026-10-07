'use strict';
// SOAP fault renderer (registered as error format "soap") and envelope helpers.
//
// Two kinds of errors reach a SOAP client:
//   - transport level, before the envelope is processed (auth, rate limit, required headers, chaos,
//     unknown service, wrong Content-Type): the real HTTP status is kept (401 + WWW-Authenticate,
//     429 + Retry-After, an injected 503, …) and the body is a fault, so both HTTP-aware and
//     SOAP-aware clients can react.
//   - envelope level, once the Envelope was read (bad request element, unknown operation, validation,
//     not found, WS-Security, …): SOAP rules apply. SOAP 1.1 faults use HTTP 500; SOAP 1.2 Sender
//     faults use 400 and Receiver faults 500.
const { registerErrorRenderer } = require('../../util/problem');
const { NS, escapeXml } = require('./xml');

const CONTENT_TYPE = { '1.1': 'text/xml; charset=utf-8', '1.2': 'application/soap+xml; charset=utf-8' };

function versionFromContentType(req) {
  return /^\s*application\/soap\+xml/i.test(req.get('content-type') || '') ? '1.2' : '1.1';
}

function soapVersion(req) {
  return req.soap?.version || versionFromContentType(req);
}

function envelope(version, bodyXml, extraNs = '') {
  const ns = version === '1.2' ? NS.soap12 : NS.soap11;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope xmlns:soap="${ns}" xmlns:xsi="${NS.xsi}"${extraNs}><soap:Body>${bodyXml}</soap:Body></soap:Envelope>`;
}

// problem.code -> PascalCase subcode, e.g. "not-found" -> "NotFound"
const pascal = (s) => String(s || 'Error').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Error';

const SPECIAL = {
  'version-mismatch': { v11: 'soap:VersionMismatch', v12: 'soap:VersionMismatch' },
  'must-understand': { v11: 'soap:MustUnderstand', v12: 'soap:MustUnderstand' },
};
const WSSE_CODES = { 'wsse-security-required': 'wsse:InvalidSecurity', 'wsse-invalid-security': 'wsse:InvalidSecurity', 'wsse-failed-authentication': 'wsse:FailedAuthentication' };

function faultDetail(p) {
  const errors = (p.errors || []).map((e) => `<f:error field="${escapeXml(e.field ?? '')}">${escapeXml(e.message ?? '')}</f:error>`).join('');
  return `<f:faultDetail xmlns:f="${NS.faults}">`
    + `<f:status>${p.status}</f:status>${p.code ? `<f:code>${escapeXml(p.code)}</f:code>` : ''}`
    + `<f:title>${escapeXml(p.title)}</f:title><f:detail>${escapeXml(p.detail)}</f:detail>`
    + `${p.requestId ? `<f:requestId>${escapeXml(p.requestId)}</f:requestId>` : ''}<f:timestamp>${escapeXml(p.timestamp)}</f:timestamp>`
    + `${errors ? `<f:errors>${errors}</f:errors>` : ''}</f:faultDetail>`;
}

function renderFault(p, req) {
  const version = soapVersion(req);
  const inEnvelope = !!req.soap?.inEnvelope;
  const sender = p.status < 500;
  let status = p.status;
  if (inEnvelope) status = version === '1.2' && sender ? 400 : 500;

  const special = SPECIAL[p.code];
  const wsse = WSSE_CODES[p.code];
  const wsseNs = wsse ? ` xmlns:wsse="${NS.wsse}"` : '';
  let fault;
  if (version === '1.2') {
    const value = special ? special.v12 : sender ? 'soap:Sender' : 'soap:Receiver';
    const sub = wsse || `f:${pascal(p.code || p.title)}`;
    fault = `<soap:Fault${wsseNs} xmlns:f="${NS.faults}"><soap:Code><soap:Value>${value}</soap:Value>`
      + `<soap:Subcode><soap:Value>${sub}</soap:Value></soap:Subcode></soap:Code>`
      + `<soap:Reason><soap:Text xml:lang="en">${escapeXml(p.detail)}</soap:Text></soap:Reason>`
      + `<soap:Detail>${faultDetail(p)}</soap:Detail></soap:Fault>`;
  } else {
    const code = special ? special.v11 : wsse || (sender ? 'soap:Client' : 'soap:Server');
    fault = `<soap:Fault${wsseNs}><faultcode>${code}</faultcode><faultstring>${escapeXml(p.detail)}</faultstring>`
      + `<detail>${faultDetail(p)}</detail></soap:Fault>`;
  }
  return { status, contentType: CONTENT_TYPE[version], body: envelope(version, fault) };
}

registerErrorRenderer('soap', renderFault);

module.exports = { CONTENT_TYPE, envelope, soapVersion, versionFromContentType, renderFault };
