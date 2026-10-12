'use strict';
// OpenAI-style error renderer (error format "openai"):
//   {"error": {"message", "type", "param", "code"}}
// with the HTTP status as given (401, 404, 429 + Retry-After, an injected 503, …). The type and code follow
// what OpenAI-compatible clients and SDKs switch on (invalid_request_error, invalid_api_key,
// rate_limit_exceeded, server_error, …).
const { registerErrorRenderer } = require('../../util/problem');

function typeFor(status) {
  if (status === 401) return 'invalid_request_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'invalid_request_error';
  if (status === 429) return 'requests';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

function codeFor(p) {
  if (p.status === 401) return 'invalid_api_key';
  if (p.status === 429) return 'rate_limit_exceeded';
  if (p.code && /^[a-z0-9_]+$/.test(p.code)) return p.code; // our own OpenAI-style codes (model_not_found, …)
  if (p.status === 503) return 'service_unavailable';
  if (p.status >= 500) return 'server_error';
  return p.code ? String(p.code).replace(/-/g, '_') : null;
}

function renderOpenAIError(p) {
  const field = p.errors && p.errors.length ? p.errors[0].field : null;
  const message = p.errors && p.errors.length > 1
    ? `${p.detail} (${p.errors.map((e) => `${e.field}: ${e.message}`).join('; ')})`
    : p.detail;
  return {
    status: p.status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ error: { message, type: typeFor(p.status), param: field ?? null, code: codeFor(p) } }),
  };
}

registerErrorRenderer('openai', renderOpenAIError);

module.exports = { renderOpenAIError };
