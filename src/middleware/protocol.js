'use strict';
// Shared middleware stack for every mock protocol surface (/v1 REST today; SOAP, OData, GraphQL,
// SSE and WebSocket upgrades later). One place defines the order, so all protocols get the same
// required-headers, rate-limit, auth and chaos behaviour - only the error *shape* differs.
//
//   errorFormat -> [protocol body parser] -> required headers -> rate limit -> auth -> chaos
//
// The error format is set first so that body-parse failures, 401s and 429s are all rendered by the
// protocol's own renderer (registered with registerErrorRenderer in util/problem.js).
//
// The shared middleware instances are created once per app context, so the rate limiter counts
// requests across all protocols (RATE_LIMIT_RPM is one budget per client, not one per protocol).
const { requiredHeaders } = require('./headers');
const rateLimit = require('./ratelimit');
const { makeAuth } = require('./auth');
const { makeChaos } = require('./chaos');
const { errorFormats } = require('../util/problem');

function errorFormat(name) {
  return (req, res, next) => {
    req.errorFormat = name;
    next();
  };
}

function shared(ctx) {
  if (!ctx.protocolShared) {
    ctx.protocolShared = {
      requiredHeaders: requiredHeaders(ctx.settings),
      rateLimit: rateLimit(ctx.settings),
      auth: makeAuth(ctx),
      chaos: makeChaos(ctx),
    };
  }
  return ctx.protocolShared;
}

// Returns an array of middleware for router.use(...stack).
//   format - name of a registered error renderer ('problem', later 'soap', 'odata', ...)
//   body   - optional body-parser middleware (or array of them) for this protocol
function protocolStack(ctx, { format = 'problem', body } = {}) {
  if (!errorFormats().includes(format)) throw new Error(`Unknown error format "${format}". Registered: ${errorFormats().join(', ')}`);
  const s = shared(ctx);
  return [
    errorFormat(format),
    ...(body ? [].concat(body) : []),
    s.requiredHeaders,
    s.rateLimit,
    s.auth,
    s.chaos,
  ];
}

module.exports = { protocolStack, errorFormat };
