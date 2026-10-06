'use strict';
// Catch-all capture for every non-reserved path, plus optional capture of /v1/* traffic (INSPECTOR_LOG_ALL).

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

// Captures /v1/* requests after body parsing; the response is recorded when it finishes.
function logAll(ctx) {
  const { inspector, settings } = ctx;
  return function inspectorLogAll(req, res, next) {
    if (!settings.get('inspectorLogAll')) return next();
    const started = Date.now();
    const chunks = [];
    let size = 0;
    const origWrite = res.write;
    const origEnd = res.end;
    res.write = function w(chunk, ...rest) {
      if (chunk && size < 65536) { const b = Buffer.from(chunk); chunks.push(b); size += b.length; }
      return origWrite.call(this, chunk, ...rest);
    };
    res.end = function e(chunk, ...rest) {
      if (chunk && typeof chunk !== 'function' && size < 65536) { const b = Buffer.from(chunk); chunks.push(b); size += b.length; }
      return origEnd.call(this, chunk, ...rest);
    };
    const pending = inspector.capture(req, Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0), 'v1');
    res.on('finish', async () => {
      try {
        const entry = await pending;
        await inspector.complete(entry, {
          status: res.statusCode,
          headers: { ...res.getHeaders() },
          body: Buffer.concat(chunks).subarray(0, 65536),
          contentType: res.get('Content-Type'),
          durationMs: Date.now() - started,
        });
      } catch (e) {
        console.error('[inspector]', e.message);
      }
    });
    next();
  };
}

module.exports = { catchAll, logAll };
