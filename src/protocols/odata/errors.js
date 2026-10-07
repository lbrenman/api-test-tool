'use strict';
// OData error renderer (error format "odata"):
//   {"error": {"code", "message", "target"?, "details": [{code, message, target}], "innererror": {…}}}
// with the HTTP status as given (401 + WWW-Authenticate, 404, 412, 429 + Retry-After, an injected 503, …).
const { registerErrorRenderer } = require('../../util/problem');

function renderODataError(p) {
  const details = (p.errors || []).map((e) => ({ code: 'invalid-value', message: e.message, target: e.field }));
  const error = {
    code: p.code || p.title.replace(/\s+/g, ''),
    message: p.detail,
    ...(details.length === 1 ? { target: details[0].target } : {}),
    details,
    innererror: { status: p.status, title: p.title, requestId: p.requestId, timestamp: p.timestamp, type: p.type },
  };
  return {
    status: p.status,
    contentType: 'application/json; odata.metadata=minimal; charset=utf-8',
    body: JSON.stringify({ error }),
    headers: { 'OData-Version': '4.0' },
  };
}

registerErrorRenderer('odata', renderODataError);

module.exports = { renderODataError };
