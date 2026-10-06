'use strict';
// Fixed-window rate limiter (per client IP + credential) emitting IETF RateLimit-* headers.
const { sendProblem } = require('../util/problem');

module.exports = function rateLimit(settings) {
  const windows = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, w] of windows) if (w.reset <= now) windows.delete(k);
  }, 60000).unref();

  return (req, res, next) => {
    const limit = settings.get('rateLimitRpm');
    if (!limit) return next();
    const now = Date.now();
    const key = `${req.ip}|${(req.get('authorization') || req.get(settings.get('apiKeyName')) || '').slice(0, 64)}`;
    let w = windows.get(key);
    if (!w || w.reset <= now) {
      w = { count: 0, reset: now + 60000 };
      windows.set(key, w);
    }
    w.count += 1;
    const resetSec = Math.max(1, Math.ceil((w.reset - now) / 1000));
    res.setHeader('RateLimit-Policy', `${limit};w=60`);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - w.count)));
    res.setHeader('RateLimit-Reset', String(resetSec));
    if (w.count > limit) {
      return sendProblem(req, res, 429, {
        detail: `Rate limit of ${limit} requests per minute exceeded`,
        headers: { 'Retry-After': String(resetSec) },
        code: 'rate-limited',
      });
    }
    next();
  };
};
