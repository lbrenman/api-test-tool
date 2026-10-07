'use strict';
// Catch-all capture for every non-reserved path, plus capture of /v1/*, /soap/* and /oauth/* traffic (INSPECTOR_LOG_ALL).

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve({ buf: Buffer.concat(chunks), size, over }));
    req.on('error', reject);
  });
}

function catchAll(ctx) {
  const { inspector, settings } = ctx;
  return async function inspectorCatchAll(req, res) {
    const started = Date.now();
    const limit = settings.get('maxFileSizeMb') * 1024 * 1024;
    const { buf, over } = await readRaw(req, limit);
    const entry = await inspector.capture(req, buf, 'catch-all');
    if (over) entry.body.overLimit = true;
    const out = inspector.resolveResponse(req, entry);
    if (out.delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(out.delayMs, 120000)));
    res.setHeader('X-Inspector-Id', entry.id);
    for (const [k, v] of Object.entries(out.headers)) {
      try { res.setHeader(k, v); } catch { /* invalid header */ }
    }
    if (!res.get('Content-Type') && out.body !== '') res.setHeader('Content-Type', out.contentType);
    res.status(out.status);
    const noBody = req.method === 'HEAD' || out.status === 204 || out.status === 304;
    // Record the response before sending it, so a capture is complete as soon as the caller has its answer.
    try {
      await inspector.complete(entry, { status: out.status, headers: { ...res.getHeaders() }, body: noBody ? null : out.body, contentType: res.get('Content-Type'), rule: out.rule, durationMs: Date.now() - started });
    } catch (e) {
      console.error('[inspector]', e.message);
    }
    res.end(noBody ? undefined : out.body);
    inspector.forward(entry).catch((e) => console.error('[inspector] forward', e.message));
  };
}

const MAX_RESPONSE_CAPTURE = 65536;

// Which API traffic is recorded when INSPECTOR_LOG_ALL is on. The dashboard, admin API, docs and
// health probes are the tool's own plumbing and are never recorded.
function apiKind(path) {
  if (path === '/v1' || path.startsWith('/v1/')) return 'v1';
  if (path === '/soap' || path.startsWith('/soap/')) return 'soap';
  if (path === '/ws' || path.startsWith('/ws/')) return 'ws';
  if (path.startsWith('/oauth/') || path.startsWith('/.well-known/')) return 'oauth';
  return null;
}

// Records /v1/*, /soap/* and /oauth/* calls. Mounted before every router and body parser, so requests that are
// rejected early (malformed body, missing headers, auth, rate limit, chaos) are recorded too. The entry is
// written once the response finishes, or when the connection closes early (chaos drop/timeout, client abort).
function logAll(ctx) {
  const { inspector, settings } = ctx;
  return function inspectorLogAll(req, res, next) {
    const kind = apiKind(req.path);
    if (!kind || !settings.get('inspectorLogAll')) return next();
    const started = Date.now();
    const ip = req.ip; // read now: a dropped socket loses its remote address
    const chunks = [];
    let size = 0;
    const keep = (chunk, enc) => {
      if (!chunk || typeof chunk === 'function' || size >= MAX_RESPONSE_CAPTURE) return;
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');
      chunks.push(b);
      size += b.length;
    };
    const origWrite = res.write;
    const origEnd = res.end;
    res.write = function w(chunk, ...rest) { keep(chunk, rest[0]); return origWrite.call(this, chunk, ...rest); };
    res.end = function e(chunk, ...rest) { keep(chunk, rest[0]); return origEnd.call(this, chunk, ...rest); };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const upgraded = !!req.ws?.accepted; // WebSocket handshake completed on the raw socket
      const aborted = upgraded ? false : !res.writableFinished;
      inspector.record(req, Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0), kind, {
        startedAt: started,
        ip,
        status: upgraded ? 101 : res.headersSent || !aborted ? res.statusCode : null,
        headers: { ...res.getHeaders() },
        body: Buffer.concat(chunks).subarray(0, MAX_RESPONSE_CAPTURE),
        contentType: res.get('Content-Type'),
        durationMs: Date.now() - started,
        aborted,
      }).catch((err) => console.error('[inspector]', err.message));
    };
    res.on('finish', finish);
    res.on('close', finish);
    next();
  };
}

module.exports = { catchAll, logAll, apiKind };
