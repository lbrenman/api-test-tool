'use strict';
// GraphQL error shapes.
//
// Two kinds of errors reach a GraphQL client:
//   - request / transport errors, before execution (auth, rate limit, required headers, chaos, bad
//     body, parse or validation failure): no "data" entry; registered here as error format "graphql".
//     Transport errors keep their real HTTP status (401 + WWW-Authenticate, 429 + Retry-After, an
//     injected 503, …) so HTTP-aware clients can react.
//   - field errors during execution (validation of mutation input, not found, conflicts, injected
//     field errors): HTTP 200 with partial "data" and "errors" carrying extensions.code.
const { GraphQLError } = require('graphql');
const { registerErrorRenderer, TITLES } = require('../../util/problem');

const RESPONSE_TYPE = 'application/graphql-response+json';

// HTTP status -> extensions.code (common GraphQL server conventions).
const CODES = {
  400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE', 409: 'CONFLICT', 412: 'PRECONDITION_FAILED', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'BAD_USER_INPUT', 429: 'RATE_LIMITED', 500: 'INTERNAL_SERVER_ERROR', 501: 'NOT_IMPLEMENTED', 502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE', 504: 'GATEWAY_TIMEOUT',
};
const codeFor = (status) => CODES[status] || (status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST');

// Which media type the client asked for (GraphQL over HTTP): application/graphql-response+json when
// it accepts that and does not prefer application/json, else application/json.
function responseType(req) {
  const accept = String(req.get?.('accept') || '');
  if (!accept.includes(RESPONSE_TYPE)) return 'application/json';
  const q = (type) => {
    const part = accept.split(',').find((p) => p.trim().toLowerCase().startsWith(type));
    if (!part) return -1;
    const m = /;\s*q=([\d.]+)/.exec(part);
    return m ? Number(m[1]) : 1;
  };
  return q(RESPONSE_TYPE) >= q('application/json') ? RESPONSE_TYPE : 'application/json';
}

// Any thrown error -> GraphQLError with extensions { code, status, problemCode?, errors?, requestId? }.
function toGraphQLError(e, extra = {}) {
  if (e instanceof GraphQLError) {
    if (e.originalError && e.originalError.status) return toGraphQLError(e.originalError, extra);
    return e;
  }
  const status = Number.isInteger(e?.status) ? e.status : 500;
  const message = status >= 500 && !e?.status ? 'Unexpected error while resolving this field' : (e?.detail || e?.message || TITLES[status] || 'Error');
  return new GraphQLError(message, {
    originalError: e instanceof Error ? e : undefined,
    extensions: {
      code: codeFor(status),
      status,
      ...(e?.code ? { problemCode: e.code } : {}),
      ...(e?.errors?.length ? { errors: e.errors } : {}),
      ...extra,
    },
  });
}

// Renderer for request/transport errors (the problem -> a GraphQL response without "data").
function renderGraphQLError(p, req) {
  const extensions = { code: codeFor(p.status), status: p.status, ...(p.code ? { problemCode: p.code } : {}), requestId: p.requestId, timestamp: p.timestamp };
  if (p.errors?.length) extensions.errors = p.errors;
  return {
    status: p.status,
    contentType: `${responseType(req)}; charset=utf-8`,
    body: JSON.stringify({ errors: [{ message: p.detail, extensions }] }),
  };
}

registerErrorRenderer('graphql', renderGraphQLError);

module.exports = { toGraphQLError, codeFor, responseType, RESPONSE_TYPE, renderGraphQLError };
