'use strict';
// RFC 9457 problem+json helpers.

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

function sendProblem(req, res, status, opts = {}) {
  if (res.headersSent) return;
  if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) res.setHeader(k, v);
  res.status(status).type('application/problem+json').send(JSON.stringify(problemBody(req, status, opts)));
}

module.exports = { HttpError, sendProblem, problemBody, TITLES };
