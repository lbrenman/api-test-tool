'use strict';
// Body parsing for /v1/*. Keeps the raw bytes (req.rawBody) for HMAC and idempotency fingerprints.
// File-transfer endpoints stream their own bodies, except base64/presign which are JSON.
const express = require('express');

const verify = (req, _res, buf) => { req.rawBody = buf; };
const JSON_TYPES = ['application/json', 'application/merge-patch+json', 'application/*+json'];

function v1Body(settings) {
  const json = express.json({ limit: '2mb', type: JSON_TYPES, verify });
  const form = express.urlencoded({ extended: true, limit: '2mb', verify });
  const text = express.text({ type: ['text/*', 'application/xml'], limit: '2mb', verify });
  let bigLimitMb = null;
  let big = null;

  return (req, res, next) => {
    const p = req.path;
    const isFiles = p === '/files' || p.startsWith('/files/');
    if (isFiles && !(p === '/files/base64' || p === '/files/presign')) return next();
    if (p === '/files/base64') {
      const mb = settings.get('maxFileSizeMb');
      if (mb !== bigLimitMb) {
        bigLimitMb = mb;
        // base64 inflates by ~4/3, plus JSON overhead
        big = express.json({ limit: Math.ceil(mb * 1.4 + 1) * 1024 * 1024, type: JSON_TYPES, verify });
      }
      return big(req, res, next);
    }
    json(req, res, (err) => {
      if (err) return next(err);
      form(req, res, (err2) => {
        if (err2) return next(err2);
        text(req, res, next);
      });
    });
  };
}

module.exports = { v1Body, verify, JSON_TYPES };
