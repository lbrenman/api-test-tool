'use strict';
// /p/<profile>/… : runs the rest of the request with that settings profile (services/profiles.js) and without the
// prefix, so /p/hmac/v1/employees is /v1/employees with AUTH_MODE=hmac. req.originalUrl keeps the prefix: it is
// what the client sent and signed (HMAC, SigV4) and what links are built from. The dashboard and admin API are global.
const { sendProblem } = require('../util/problem');

const PREFIX = /^\/p\/([^/?#]*)/;
const GLOBAL_ONLY = /^\/(dashboard|app|admin)(?=[/?#]|$)/;

function profileRouting(ctx) {
  return function profile(req, res, next) {
    const m = PREFIX.exec(req.url);
    if (!m) return next();
    const name = m[1];
    const p = ctx.profiles.get(name);
    if (!p) {
      return sendProblem(req, res, 404, { detail: `No settings profile "${name}". Profiles: ${ctx.profiles.list().map((x) => x.name).join(', ')}`, code: 'profile-not-found' });
    }
    const rest = req.url.slice(m[0].length);
    const local = rest.startsWith('/') ? rest : `/${rest}`;
    if (GLOBAL_ONLY.test(local)) return sendProblem(req, res, 404, { detail: `${local.split('?')[0]} is not available inside a profile; use it without the /p/${name} prefix`, code: 'profile-global-only' });
    req.url = local;
    req.profile = { name: p.name, prefix: m[0], store: ctx.profiles.store(p) };
    return ctx.settings.runIn(req.profile.store, next);
  };
}

// Re-enters the request's profile. Body parsers resume the chain from stream callbacks, which can run outside the
// request's async context; protocolStack puts this right after the body parser, before auth reads AUTH_MODE.
function rescope(ctx) {
  return (req, res, next) => (req.profile ? ctx.settings.runIn(req.profile.store, next) : next());
}

module.exports = { profileRouting, rescope };
