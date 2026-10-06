'use strict';
// Dashboard / admin API protection: single ADMIN_PASSWORD. Signed session cookie, with HTTP Basic as a fallback
// for scripts (any username). When ADMIN_PASSWORD is unset everything is open and a warning is logged.
const crypto = require('node:crypto');

const COOKIE = 'att_admin';
const MAX_AGE_S = 7 * 24 * 3600;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function makeAdminAuth(settings) {
  const password = () => settings.get('adminPassword');
  const key = () => crypto.createHash('sha256').update(`api-test-tool|${password()}`).digest();

  function sign(exp) {
    return crypto.createHmac('sha256', key()).update(`admin.${exp}`).digest('base64url');
  }

  function cookieValue() {
    const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
    return `${exp}.${sign(exp)}`;
  }

  function valid(req) {
    if (!password()) return true;
    const c = parseCookies(req.get('cookie'))[COOKIE];
    if (c) {
      const [exp, sig] = c.split('.');
      if (Number(exp) > Date.now() / 1000 && sig) {
        const a = Buffer.from(sig);
        const b = Buffer.from(sign(exp));
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
      }
    }
    const h = req.get('authorization') || '';
    if (/^basic /i.test(h)) {
      const dec = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
      const pass = dec.slice(dec.indexOf(':') + 1);
      const a = Buffer.from(pass);
      const b = Buffer.from(password());
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
    return false;
  }

  function login(req, res) {
    const given = String(req.body?.password ?? '');
    const a = Buffer.from(given);
    const b = Buffer.from(password() || '');
    if (!password() || (a.length === b.length && crypto.timingSafeEqual(a, b))) {
      const secure = req.secure ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE}=${cookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure}`);
      return true;
    }
    return false;
  }

  function logout(_req, res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  function requireApi(req, res, next) {
    if (valid(req)) return next();
    res.status(401).type('application/problem+json').json({
      type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Admin login required', instance: req.originalUrl,
    });
  }

  function requirePage(req, res, next) {
    if (valid(req)) return next();
    res.redirect(302, `/dashboard/login?next=${encodeURIComponent(req.originalUrl)}`);
  }

  return { valid, login, logout, requireApi, requirePage, enabled: () => !!password() };
}

module.exports = { makeAdminAuth, parseCookies };
