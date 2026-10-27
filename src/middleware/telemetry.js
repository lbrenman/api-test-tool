'use strict';
// Measures every request for services/telemetry.js: the duration histogram behind /metrics and, when OTLP trace
// export is on, one server span per API request. Mounted right after requestId, so requests rejected early
// (unknown profile, malformed body, auth, rate limit, chaos) are measured too. The request is recorded once, when the
// response finishes or the connection closes first (client abort, chaos reset/timeout, end of a stream).
module.exports = function telemetry(ctx) {
  return function telemetryMiddleware(req, res, next) {
    const t = ctx.telemetry;
    if (!t) return next();
    let st;
    try { st = t.begin(req); } catch (e) { ctx.log('warn', 'telemetry:', e.message); return next(); }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { t.end(req, res, st); } catch (e) { ctx.log('warn', 'telemetry:', e.message); }
    };
    res.on('finish', finish);
    res.on('close', finish);
    next();
  };
};
