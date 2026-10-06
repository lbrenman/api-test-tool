'use strict';
// Custom response headers (all responses) and required request headers (/v1/* only).
const { sendProblem } = require('../util/problem');

function responseHeaders(settings) {
  return (req, res, next) => {
    for (const h of settings.get('responseHeaders')) {
      try { res.setHeader(h.name, h.value); } catch { /* invalid header name/value: skip */ }
    }
    next();
  };
}

function requiredHeaders(settings) {
  return (req, res, next) => {
    const required = settings.get('requiredHeaders');
    if (!required.length) return next();
    const errors = [];
    for (const h of required) {
      const v = req.get(h.name);
      if (v === undefined || v === '') errors.push({ field: `header:${h.name}`, message: 'is required' });
      else if (h.value !== undefined && v !== h.value) errors.push({ field: `header:${h.name}`, message: `must equal "${h.value}"` });
    }
    if (errors.length) {
      return sendProblem(req, res, 400, {
        detail: `Missing or invalid required header(s): ${errors.map((e) => e.field.slice(7)).join(', ')}`,
        errors,
        code: 'required-header',
      });
    }
    next();
  };
}

module.exports = { responseHeaders, requiredHeaders };
