'use strict';
// X-Request-Id / X-Correlation-Id: echo when supplied (sane values only), otherwise generate.
const crypto = require('node:crypto');

const OK = /^[A-Za-z0-9._:\-]{1,200}$/;

module.exports = function requestId() {
  return (req, res, next) => {
    req.startedAt = process.hrtime.bigint();
    const given = req.get('x-request-id');
    req.id = given && OK.test(given) ? given : crypto.randomUUID();
    const corr = req.get('x-correlation-id');
    req.correlationId = corr && OK.test(corr) ? corr : req.id;
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('X-Correlation-Id', req.correlationId);
    next();
  };
};
