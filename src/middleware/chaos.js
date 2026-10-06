'use strict';
// Error & latency injection for /v1/*.
// Random: ERROR_RATE % of requests get one of ERROR_TYPES; latency uniformly in [LATENCY_MIN_MS, LATENCY_MAX_MS].
// Deterministic: X-Force-Error (status or type), X-Force-Status (override handler status), X-Force-Latency (ms). Forcing wins.
const { sendProblem } = require('../util/problem');

const BODY_TYPES = new Set(['malformed-json', 'truncated-body', 'empty-body', 'wrong-content-type', 'slow-drip']);
const SOCKET_TYPES = new Set(['timeout', 'reset']);
const TYPE_NAMES = [...BODY_TYPES, ...SOCKET_TYPES];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseTypes(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function validType(t) {
  if (/^\d{3}$/.test(t)) { const n = Number(t); return n >= 400 && n <= 599; }
  return TYPE_NAMES.includes(t);
}

function findOverride(list, req) {
  if (!Array.isArray(list)) return null;
  const p = req.originalUrl.split('?')[0];
  return list.find((o) => {
    if (!o || !o.path) return false;
    const base = String(o.path).replace(/\/+$/, '');
    const pathOk = p === base || p.startsWith(`${base}/`);
    return pathOk && (!o.method || String(o.method).toUpperCase() === req.method);
  }) || null;
}

function wrapSend(req, res, type, settings) {
  const origSend = res.send.bind(res);
  res.send = function chaosSend(body) {
    res.send = origSend;
    let str = body;
    if (Buffer.isBuffer(body)) str = body.toString('utf8');
    else if (body !== undefined && typeof body !== 'string') str = JSON.stringify(body);
    str = str ?? '';
    if (!res.get('Content-Type')) res.type('application/json');
    res.setHeader('X-Chaos-Injected', type);
    switch (type) {
      case 'malformed-json': {
        const cut = Math.max(1, Math.floor(str.length * 0.85));
        return origSend(`${str.slice(0, cut)}",,}{ "chaos": malformed`);
      }
      case 'wrong-content-type':
        res.type('text/html; charset=utf-8');
        return origSend(str);
      case 'empty-body':
        res.removeHeader('ETag');
        res.setHeader('Content-Length', '0');
        return res.end();
      case 'truncated-body': {
        const buf = Buffer.from(str);
        res.setHeader('Content-Length', String(buf.length));
        res.removeHeader('ETag');
        res.write(buf.subarray(0, Math.floor(buf.length / 2)));
        setTimeout(() => res.socket && res.socket.destroy(), 100);
        return res;
      }
      case 'slow-drip': {
        const buf = Buffer.from(str);
        const chunks = 20;
        const size = Math.max(1, Math.ceil(buf.length / chunks));
        const delay = settings.get('chaosSlowDripMs');
        res.removeHeader('Content-Length');
        res.removeHeader('ETag');
        (async () => {
          for (let i = 0; i < buf.length; i += size) {
            if (res.destroyed || res.writableEnded) return;
            res.write(buf.subarray(i, i + size));
            await sleep(delay);
          }
          res.end();
        })();
        return res;
      }
      default:
        return origSend(body);
    }
  };
}

function makeChaos(ctx) {
  const { settings } = ctx;
  return async function chaos(req, res, next) {
    const forcedError = req.get('x-force-error');
    const forcedStatus = req.get('x-force-status');
    const forcedLatency = req.get('x-force-latency');
    const ov = findOverride(settings.get('chaosRouteOverrides'), req) || {};

    // Latency
    let delay = 0;
    if (forcedLatency !== undefined) {
      const n = Number(forcedLatency);
      if (!Number.isFinite(n) || n < 0) return sendProblem(req, res, 400, { detail: 'X-Force-Latency must be a non-negative number of milliseconds' });
      delay = Math.min(n, 120000);
    } else {
      const min = ov.latencyMinMs ?? settings.get('latencyMinMs');
      const max = Math.max(min, ov.latencyMaxMs ?? settings.get('latencyMaxMs'));
      if (max > 0) delay = Math.round(min + Math.random() * (max - min));
    }
    if (delay > 0) {
      res.setHeader('X-Chaos-Latency', String(delay));
      await sleep(delay);
      if (req.socket.destroyed) return;
    }

    // Forced status override (handler still runs).
    if (forcedStatus !== undefined) {
      const code = Number(forcedStatus);
      if (!Number.isInteger(code) || code < 100 || code > 599) return sendProblem(req, res, 400, { detail: 'X-Force-Status must be an HTTP status code (100-599)' });
      if (code >= 400) {
        res.setHeader('X-Chaos-Injected', `status-${code}`);
        return sendProblem(req, res, code, { detail: `Status ${code} forced by X-Force-Status`, code: 'chaos-forced', headers: code === 429 || code === 503 ? { 'Retry-After': '5' } : undefined });
      }
      const origWriteHead = res.writeHead;
      res.writeHead = function forcedWriteHead(_code, ...rest) {
        res.setHeader('X-Chaos-Injected', `status-${code}`);
        return origWriteHead.call(this, code, ...rest);
      };
    }

    // Error selection
    let type = null;
    if (forcedError !== undefined) {
      type = String(forcedError).trim();
      if (!validType(type)) {
        return sendProblem(req, res, 400, { detail: `Unknown X-Force-Error "${type}". Use a 4xx/5xx status or one of: ${TYPE_NAMES.join(', ')}` });
      }
    } else {
      const rate = Number(ov.errorRate ?? settings.get('errorRate')) || 0;
      if (rate > 0 && Math.random() * 100 < rate) {
        const types = parseTypes(ov.errorTypes ?? settings.get('errorTypes')).filter(validType);
        if (types.length) type = types[Math.floor(Math.random() * types.length)];
      }
    }
    if (!type) return next();

    if (/^\d{3}$/.test(type)) {
      const status = Number(type);
      res.setHeader('X-Chaos-Injected', type);
      return sendProblem(req, res, status, {
        detail: `Injected ${status} error (chaos)`,
        code: 'chaos-injected',
        headers: status === 429 || status === 503 ? { 'Retry-After': '5' } : undefined,
      });
    }
    if (type === 'reset') {
      req.socket.destroy();
      return;
    }
    if (type === 'timeout') {
      res.setHeader('X-Chaos-Injected', 'timeout');
      const secs = settings.get('chaosTimeoutSeconds') || 600;
      const t = setTimeout(() => req.socket.destroy(), Math.min(secs, 600) * 1000);
      req.on('close', () => clearTimeout(t));
      return;
    }
    wrapSend(req, res, type, settings);
    next();
  };
}

module.exports = { makeChaos, TYPE_NAMES, validType };
