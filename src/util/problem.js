'use strict';
// Error rendering. Every error in the app goes through sendProblem(req, res, status, opts).
//
// By default errors are RFC 9457 problem+json. A protocol module (SOAP, OData, GraphQL, SSE, ...)
// can register its own error renderer and tag its requests with req.errorFormat = '<name>'
// (see middleware/protocol.js). Shared middleware (auth, chaos, rate limit, required headers,
// idempotency) keeps calling sendProblem and the error comes out in the protocol's native shape.

const TITLES = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 412: 'Precondition Failed',
  413: 'Content Too Large', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 418: "I'm a teapot",
  422: 'Unprocessable Content', 423: 'Locked', 425: 'Too Early', 428: 'Precondition Required', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout', 507: 'Insufficient Storage',
};

class HttpError extends Error {
  constructor(status, detail, { title, type, errors, headers, code } = {}) {
    super(detail || TITLES[status] || 'Error');
    this.status = status;
    this.detail = detail;
    this.title = title;
    this.type = type;
    this.errors = errors;
    this.headers = headers;
    this.code = code;
  }
}

function slug(status) {
  return (TITLES[status] || `status-${status}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function problemBody(req, status, { detail, title, type, errors, code } = {}) {
  const base = req.app?.locals?.ctx?.baseUrl ? req.app.locals.ctx.baseUrl(req) : '';
  const body = {
    type: type || `${base}/problems/${code || slug(status)}`,
    title: title || TITLES[status] || 'Error',
    status,
    detail: detail || TITLES[status] || 'Error',
    instance: req.originalUrl,
    requestId: req.id,
    timestamp: new Date().toISOString(),
  };
  if (code) body.code = code;
  if (errors && errors.length) body.errors = errors;
  return body;
}

// ---- Error renderer registry -------------------------------------------------
// A renderer is (problem, req) => { status?, contentType, body, headers? }
//   problem  - the problem+json object (type, title, status, detail, instance, requestId, timestamp, code?, errors?)
//   status   - HTTP status to send (defaults to problem.status; e.g. GraphQL may answer 200 with errors[])
//   body     - string or Buffer
//   headers  - extra headers specific to the protocol
// Headers passed by the caller (WWW-Authenticate, Retry-After, ...) are always applied first.
const RENDERERS = new Map();

function registerErrorRenderer(name, render) {
  if (!name || typeof render !== 'function') throw new TypeError('registerErrorRenderer(name, fn) requires a name and a function');
  RENDERERS.set(name, render);
}

function errorFormats() {
  return [...RENDERERS.keys()];
}

function renderProblem(req, status, opts = {}) {
  const problem = problemBody(req, status, opts);
  const render = RENDERERS.get(req.errorFormat) || RENDERERS.get('problem');
  try {
    const out = render(problem, req) || {};
    return { status: out.status ?? status, contentType: out.contentType, body: out.body ?? '', headers: out.headers };
  } catch (e) {
    // A broken protocol renderer must never hide the original error.
    req.app?.locals?.ctx?.log?.('error', `error renderer "${req.errorFormat}" failed:`, e);
    return RENDERERS.get('problem')(problem, req);
  }
}

function sendProblem(req, res, status, opts = {}) {
  if (res.headersSent) return;
  if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) res.setHeader(k, v);
  const out = renderProblem(req, status, opts);
  if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.status(out.status ?? status).type(out.contentType || 'application/problem+json').send(out.body);
}

// Built-in: RFC 9457 problem+json (the /v1 REST API and everything else by default).
registerErrorRenderer('problem', (problem) => ({
  status: problem.status,
  contentType: 'application/problem+json',
  body: JSON.stringify(problem),
}));

module.exports = { HttpError, sendProblem, problemBody, renderProblem, registerErrorRenderer, errorFormats, TITLES };
