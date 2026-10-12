'use strict';
// A2A error shapes.
//   JSON-RPC binding (error format "a2a"): {"jsonrpc": "2.0", "id", "error": {"code", "message", "data": [google.rpc.ErrorInfo]}}
//   HTTP+JSON binding (error format "a2a-rest"): google.rpc.Status {"error": {"code", "status", "message", "details": [ErrorInfo]}}
// A2A errors use the codes of the spec's mapping table (-32001 TaskNotFound … -32009 VersionNotSupported). Errors
// raised by the shared stack (auth, rate limit, required headers, chaos) keep their HTTP status.
const { registerErrorRenderer } = require('../../util/problem');

const ERRORS = {
  TaskNotFound: [-32001, 404, 'NOT_FOUND'],
  TaskNotCancelable: [-32002, 400, 'FAILED_PRECONDITION'],
  PushNotificationNotSupported: [-32003, 400, 'FAILED_PRECONDITION'],
  UnsupportedOperation: [-32004, 400, 'FAILED_PRECONDITION'],
  ContentTypeNotSupported: [-32005, 400, 'INVALID_ARGUMENT'],
  InvalidAgentResponse: [-32006, 500, 'INTERNAL'],
  ExtendedAgentCardNotConfigured: [-32007, 400, 'FAILED_PRECONDITION'],
  ExtensionSupportRequired: [-32008, 400, 'FAILED_PRECONDITION'],
  VersionNotSupported: [-32009, 400, 'FAILED_PRECONDITION'],
  ParseError: [-32700, 400, 'INVALID_ARGUMENT'],
  InvalidRequest: [-32600, 400, 'INVALID_ARGUMENT'],
  MethodNotFound: [-32601, 404, 'NOT_FOUND'],
  InvalidParams: [-32602, 400, 'INVALID_ARGUMENT'],
  Internal: [-32603, 500, 'INTERNAL'],
};
const STATUS_NAME = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 405: 'UNIMPLEMENTED', 409: 'ABORTED', 412: 'FAILED_PRECONDITION', 413: 'INVALID_ARGUMENT', 415: 'INVALID_ARGUMENT', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 501: 'UNIMPLEMENTED', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' };

const reasonOf = (name) => name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(); // TaskNotFound -> TASK_NOT_FOUND
const errorInfo = (reason, metadata) => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org', metadata: { ...Object.fromEntries(Object.entries(metadata || {}).map(([k, v]) => [k, String(v)])), timestamp: new Date().toISOString() } });

/** A JSON-RPC error object for an A2A error name. */
function rpcError(name, message, { meta, violations } = {}) {
  const [code] = ERRORS[name] || ERRORS.Internal;
  const data = [errorInfo(reasonOf(name), meta)];
  if (violations?.length) data.push({ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: violations.map((v) => ({ field: v.field, description: v.message })) });
  return { code, message, data };
}

/** google.rpc.Status for the HTTP+JSON binding: { status, body }. */
function restError(name, message, { meta, violations } = {}) {
  const [, http, status] = ERRORS[name] || ERRORS.Internal;
  const details = [errorInfo(reasonOf(name), meta)];
  if (violations?.length) details.push({ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: violations.map((v) => ({ field: v.field, description: v.message })) });
  return { status: http, body: { error: { code: http, status, message, details } } };
}

function stackReason(p) {
  if (p.code === 'malformed-body') return ['ParseError', -32700];
  if (p.status === 400 || p.status === 413 || p.status === 415) return ['InvalidRequest', -32600];
  return [null, p.status >= 500 ? -32603 : -32000];
}

registerErrorRenderer('a2a', (p, req) => {
  const [name, code] = stackReason(p);
  const b = req.body;
  const id = b && typeof b === 'object' && !Array.isArray(b) && 'id' in b ? b.id : null;
  return {
    status: p.status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: p.detail, data: [errorInfo(name ? reasonOf(name) : (STATUS_NAME[p.status] || 'ERROR'), { httpStatus: p.status, requestId: p.requestId, ...(p.code ? { code: p.code } : {}) })] } }),
  };
});

registerErrorRenderer('a2a-rest', (p) => ({
  status: p.status,
  contentType: 'application/a2a+json',
  body: JSON.stringify({ error: { code: p.status, status: STATUS_NAME[p.status] || 'UNKNOWN', message: p.detail, details: [errorInfo(p.code ? String(p.code).toUpperCase().replace(/-/g, '_') : (STATUS_NAME[p.status] || 'ERROR'), { requestId: p.requestId })] } }),
}));

module.exports = { ERRORS, rpcError, restError, errorInfo };
