'use strict';
// Global authentication for /v1/*. Mode comes from the AUTH_MODE setting (live).
const crypto = require('node:crypto');
const { sendProblem } = require('../util/problem');
const { safeEq } = require('../services/oauth');

const EMPTY_SHA = crypto.createHash('sha256').update('').digest('hex');

function bearerToken(req) {
  const h = req.get('authorization') || '';
  const m = /^bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  // WebSocket upgrades: browsers cannot set headers, so ?access_token= is accepted there (only).
  if (req.ws && typeof req.query?.access_token === 'string' && req.query.access_token) return req.query.access_token;
  return null;
}

function bodyHash(req) {
  if (Buffer.isBuffer(req.rawBody)) return crypto.createHash('sha256').update(req.rawBody).digest('hex');
  const hasBody = Number(req.get('content-length') || 0) > 0 || !!req.get('transfer-encoding');
  return hasBody ? 'UNSIGNED-PAYLOAD' : EMPTY_SHA;
}

function hmacCanonical(req, date) {
  return [req.method.toUpperCase(), req.originalUrl, date, bodyHash(req)].join('\n');
}

function parseTimestamp(v) {
  if (!v) return NaN;
  if (/^\d+$/.test(v)) { const n = Number(v); return n < 1e11 ? n * 1000 : n; }
  return Date.parse(v);
}

function makeAuth(ctx) {
  const { settings } = ctx;

  function fail(req, res, detail, challenge, status = 401, code = 'unauthorized') {
    return sendProblem(req, res, status, { detail, code, headers: challenge ? { 'WWW-Authenticate': challenge } : undefined });
  }

  return async function auth(req, res, next) {
    const mode = settings.get('authMode');
    req.auth = { mode };
    try {
      switch (mode) {
        case 'none':
          return next();

        case 'apikey': {
          const name = settings.get('apiKeyName');
          const where = settings.get('apiKeyIn');
          const v = where === 'query' ? req.query[name] : req.get(name);
          if (!v) return fail(req, res, `API key required in ${where} "${name}"`, `ApiKey ${where}="${name}"`);
          if (!safeEq(v, settings.get('apiKey'))) return fail(req, res, 'Invalid API key', `ApiKey ${where}="${name}"`);
          req.auth.principal = 'api-key';
          return next();
        }

        case 'basic': {
          const h = req.get('authorization') || '';
          if (!/^basic /i.test(h)) return fail(req, res, 'Basic credentials required', 'Basic realm="api-test-tool", charset="UTF-8"');
          const dec = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
          const i = dec.indexOf(':');
          const user = dec.slice(0, i);
          const pass = dec.slice(i + 1);
          if (i < 0 || !safeEq(user, settings.get('basicUser')) || !safeEq(pass, settings.get('basicPass'))) {
            return fail(req, res, 'Invalid username or password', 'Basic realm="api-test-tool", charset="UTF-8"');
          }
          req.auth.principal = user;
          return next();
        }

        case 'bearer': {
          const t = bearerToken(req);
          if (!t) return fail(req, res, 'Bearer token required', 'Bearer realm="api-test-tool"');
          if (!safeEq(t, settings.get('bearerToken'))) return fail(req, res, 'Invalid bearer token', 'Bearer realm="api-test-tool", error="invalid_token"');
          req.auth.principal = 'bearer';
          return next();
        }

        case 'jwt':
        case 'oauth2': {
          const t = bearerToken(req);
          if (!t) return fail(req, res, 'Bearer JWT required', 'Bearer realm="api-test-tool"');
          let payload;
          try {
            ({ payload } = await ctx.oauth.verifyAccess(req, t));
          } catch (e) {
            return fail(req, res, `Invalid token: ${e.message}`, `Bearer realm="api-test-tool", error="invalid_token", error_description="${String(e.message).replace(/"/g, "'")}"`);
          }
          req.auth.principal = payload.sub;
          req.auth.claims = payload;
          if (mode === 'oauth2') {
            const need = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'read' : 'write';
            const scopes = String(payload.scope || '').split(/\s+/);
            if (!scopes.includes(need)) {
              return fail(req, res, `Token lacks required scope "${need}"`, `Bearer realm="api-test-tool", error="insufficient_scope", scope="${need}"`, 403, 'insufficient-scope');
            }
          }
          return next();
        }

        case 'hmac': {
          const h = req.get('authorization') || '';
          const m = /^HMAC\s+([^:\s]+):(\S+)$/i.exec(h);
          const challenge = 'HMAC realm="api-test-tool", headers="X-Timestamp"';
          if (!m) return fail(req, res, 'Authorization: HMAC <keyId>:<base64 signature> required', challenge);
          if (m[1] !== settings.get('hmacKeyId')) return fail(req, res, `Unknown HMAC key id "${m[1]}"`, challenge);
          const date = req.get('x-timestamp') || req.get('date');
          const ts = parseTimestamp(date);
          if (!Number.isFinite(ts)) return fail(req, res, 'X-Timestamp or Date header required for HMAC', challenge);
          const skew = settings.get('hmacMaxSkewSeconds');
          if (Math.abs(Date.now() - ts) > skew * 1000) return fail(req, res, `Request timestamp outside the allowed skew of ${skew}s`, challenge);
          const canonical = hmacCanonical(req, date);
          const expected = crypto.createHmac('sha256', settings.get('hmacSecret')).update(canonical).digest('base64');
          if (!safeEq(expected, m[2])) {
            return sendProblem(req, res, 401, {
              detail: 'HMAC signature mismatch',
              code: 'bad-signature',
              headers: { 'WWW-Authenticate': challenge },
              errors: [{ field: 'canonicalString', message: JSON.stringify(canonical) }],
            });
          }
          req.auth.principal = m[1];
          return next();
        }

        default:
          return next();
      }
    } catch (e) {
      return next(e);
    }
  };
}

module.exports = { makeAuth, hmacCanonical, bodyHash, bearerToken };
