'use strict';
// JSON-RPC error renderer (error format "jsonrpc") for /mcp. Used for errors raised by the shared stack before
// the MCP handler runs (auth, rate limit, required headers, chaos, malformed JSON):
//   {"jsonrpc": "2.0", "id": <request id or null>, "error": {"code", "message", "data": {status, code, requestId}}}
// The HTTP status is kept (401, 429, 503, …) so MCP clients and gateways see the real transport outcome.
// A 401/403 Bearer challenge gets resource_metadata (RFC 9728) pointing at the protected resource metadata,
// which is how MCP clients discover the authorization server.
const { registerErrorRenderer } = require('../../util/problem');

function rpcCode(p) {
  if (p.code === 'malformed-body') return -32700;
  if (p.status === 400 || p.status === 413 || p.status === 415) return -32600;
  if (p.status === 401) return -32001;
  if (p.status === 403) return -32003;
  if (p.status === 404) return -32601;
  if (p.status === 429) return -32005;
  if (p.status >= 500) return -32603;
  return -32000;
}

function requestIdOf(req) {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) && ('id' in b) ? b.id : null;
}

function renderJsonRpcError(p, req) {
  const headers = {};
  const challenge = req.res?.getHeader?.('WWW-Authenticate');
  if ((p.status === 401 || p.status === 403) && typeof challenge === 'string' && /^Bearer\b/i.test(challenge) && !/resource_metadata=/.test(challenge)) {
    const base = req.app?.locals?.ctx?.baseUrl ? req.app.locals.ctx.baseUrl(req) : '';
    headers['WWW-Authenticate'] = `${challenge}, resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
  }
  return {
    status: p.status,
    contentType: 'application/json; charset=utf-8',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestIdOf(req),
      error: { code: rpcCode(p), message: p.detail, data: { status: p.status, code: p.code || null, requestId: p.requestId, ...(p.errors?.length ? { errors: p.errors } : {}) } },
    }),
  };
}

registerErrorRenderer('jsonrpc', renderJsonRpcError);

module.exports = { renderJsonRpcError };
