'use strict';
// /sse — Server-Sent Events mock streams.
//
//   GET  /sse            stream list (JSON, open)
//   GET  /sse/changes    live created/updated/deleted events for the mock data (any protocol), with
//                        Last-Event-ID resume from a replay buffer; ?resource= filters
//   GET  /sse/ticks      synthetic numbered events: ?interval=ms&count=n&event=name; resumable
//   POST /sse/stream     a request that answers with a stream (LLM-style token streaming):
//                        body { prompt?, words?, delayMs?, format?: "events" | "openai" }
//
// Requests go through the shared protocol stack (auth, rate limit, required headers, chaos at the
// start of the stream). Stream-level failures are opt-in per request with query parameters:
//   dropAfter=N    the connection is cut after N events (tests reconnect + Last-Event-ID)
//   malformedAt=N  event N is sent as a broken frame
//   skipIds=true   event ids jump (tests gap handling)
// Browsers' EventSource cannot set headers, so ?access_token= is accepted for bearer/jwt/oauth2.
const crypto = require('node:crypto');
const express = require('express');
const { HttpError, sendProblem } = require('../../util/problem');
const { protocolStack } = require('../../middleware/protocol');
const { verify, JSON_TYPES } = require('../../middleware/body');
const { NAMES } = require('../../services/resources');

const int = (v, def, min, max) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Expected an integer between ${min} and ${max}, got "${v}"`, { code: 'invalid-parameter' });
  return n;
};

/** Ring buffer of change events with increasing ids, fed by ctx.events. */
class ChangeLog {
  constructor(events, size) {
    this.size = size;
    this.seq = 0;
    this.items = [];
    events.on('change', (e) => this.push(e));
  }

  push(e) {
    this.seq += 1;
    this.items.push({ seq: this.seq, e });
    while (this.items.length > this.size()) this.items.shift();
  }

  since(id) { return this.items.filter((x) => x.seq > id); }

  get oldest() { return this.items.length ? this.items[0].seq : this.seq + 1; }
}

function frame({ id, event, data, comment }) {
  if (comment !== undefined) return `: ${comment}\n\n`;
  let out = '';
  if (id !== undefined && id !== null) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of String(text).split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

// Common stream plumbing: headers, retry, heartbeats, per-request chaos, cleanup.
function openStream(req, res, settings) {
  const chaos = {
    dropAfter: int(req.query.dropAfter, 0, 0, 1e6),
    malformedAt: int(req.query.malformedAt, 0, 0, 1e6),
    skipIds: String(req.query.skipIds || '') === 'true',
  };
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (chaos.dropAfter || chaos.malformedAt || chaos.skipIds) res.setHeader('X-Chaos-Injected', Object.entries(chaos).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(','));
  res.flushHeaders();
  req.socket.setNoDelay?.(true);
  req.socket.setTimeout?.(0);
  res.write(`retry: ${settings.get('sseRetryMs')}\n\n`);

  const s = { closed: false, sent: 0, timers: [], onClose: [] };
  const hb = settings.get('sseHeartbeatSeconds');
  if (hb) s.timers.push(setInterval(() => { if (!s.closed) res.write(frame({ comment: `keepalive ${new Date().toISOString()}` })); }, hb * 1000));
  const cleanup = () => {
    if (s.closed) return;
    s.closed = true;
    for (const t of s.timers) clearInterval(t);
    for (const f of s.onClose) f();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  s.send = (ev) => {
    if (s.closed) return false;
    s.sent += 1;
    const text = chaos.malformedAt && s.sent === chaos.malformedAt
      ? `id ${ev.id ?? ''}\nevent: ${ev.event || 'message'}\ndata: {"broken": \n\n` // missing colon on id, invalid JSON
      : frame(ev);
    if (chaos.dropAfter && s.sent >= chaos.dropAfter) {
      // Cut the connection (no clean end of the chunked body) once this last event is on the wire.
      cleanup();
      res.write(text, () => res.socket?.destroy());
      return false;
    }
    res.write(text);
    return true;
  };
  s.end = (ev) => {
    if (s.closed) return;
    if (ev) res.write(frame(ev));
    cleanup();
    res.end();
  };
  s.chaos = chaos;
  return s;
}

function lastEventId(req) {
  const v = req.get('last-event-id') ?? req.query.lastEventId;
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Deterministic "assistant" text built from the mock data.
async function streamText(ctx, prompt, words) {
  const emps = await ctx.resources.render('employees', (await ctx.resources.all('employees')).slice(0, 50));
  const parts = [];
  if (prompt) parts.push(`You asked: "${String(prompt).slice(0, 200)}".`);
  parts.push('Here is a quick look at the team.');
  for (const e of emps) parts.push(`${e.firstName} ${e.lastName} works as ${e.title || 'a team member'} in ${e.department?.name || 'the company'}.`);
  const all = parts.join(' ').split(/\s+/).filter(Boolean);
  const out = [];
  while (out.length < words) out.push(...all);
  return out.slice(0, words);
}

module.exports = function sseRouter(ctx) {
  const { settings, baseUrl } = ctx;
  const r = express.Router();
  const log = new ChangeLog(ctx.events, () => settings.get('sseReplayBuffer'));
  ctx.changeLog = log;

  r.use((req, res, next) => {
    if (!settings.get('sseEnabled')) return sendProblem(req, res, 404, { detail: 'The SSE mock is disabled (SSE_ENABLED=false)', code: 'sse-disabled' });
    req.allowQueryToken = true; // EventSource cannot send an Authorization header
    next();
  });

  r.get('/', (req, res) => {
    const b = baseUrl(req);
    res.json({
      streams: [
        { name: 'changes', method: 'GET', url: `${b}/sse/changes`, description: 'Live created/updated/deleted events for the mock data; Last-Event-ID resume; ?resource= filters.' },
        { name: 'ticks', method: 'GET', url: `${b}/sse/ticks?interval=1000&count=10`, description: 'Numbered synthetic events; resumable.' },
        { name: 'stream', method: 'POST', url: `${b}/sse/stream`, description: 'Request/stream (LLM-style): {"prompt": "…", "words": 40, "delayMs": 40, "format": "events" | "openai"}.' },
      ],
      chaos: 'dropAfter=N, malformedAt=N, skipIds=true (query parameters on any stream)',
      replayBuffer: settings.get('sseReplayBuffer'),
      lastEventId: log.seq,
    });
  });

  const stack = protocolStack(ctx, { format: 'problem', body: express.json({ limit: '1mb', type: JSON_TYPES, verify }) });

  r.get('/changes', ...stack, (req, res) => {
    const want = String(req.query.resource || '').split(',').map((x) => x.trim()).filter(Boolean);
    const bad = want.filter((w) => !NAMES.includes(w));
    if (bad.length) throw new HttpError(400, `Unknown resource ${bad.join(', ')}. Use: ${NAMES.join(', ')}`, { code: 'unknown-resource' });
    const s = openStream(req, res, settings);
    let skip = 0;
    const emit = ({ seq, e }) => {
      if (want.length && !want.includes(e.resource)) return;
      if (s.chaos.skipIds) skip += 1;
      s.send({ id: seq + skip, event: e.type, data: { ...e, ...(e.data ? { data: ctx.dates.formatDoc(e.data) } : {}) } });
    };
    const from = lastEventId(req);
    if (from !== null) {
      if (from < log.oldest - 1) s.send({ event: 'reset', data: { reason: 'Last-Event-ID is older than the replay buffer; some events were missed', lastEventId: from, oldest: log.oldest } });
      for (const x of log.since(from)) emit(x);
    } else {
      s.send({ event: 'subscribed', data: { resources: want.length ? want : NAMES, lastEventId: log.seq, at: new Date().toISOString() } });
    }
    const onChange = () => { const x = log.items[log.items.length - 1]; if (x) emit(x); };
    ctx.events.on('change', onChange);
    s.onClose.push(() => ctx.events.off('change', onChange));
  });

  r.get('/ticks', ...stack, (req, res) => {
    const interval = int(req.query.interval, settings.get('sseTickIntervalMs'), 50, 60000);
    const count = int(req.query.count, 0, 0, 1e6);
    const event = String(req.query.event || 'tick').replace(/[^\w.-]/g, '').slice(0, 40) || 'tick';
    const start = (lastEventId(req) ?? 0) + 1;
    const s = openStream(req, res, settings);
    let n = start;
    const tick = () => {
      if (s.closed) return;
      if (count && n > count) { s.end({ event: 'end', data: { n: n - 1, count } }); return; }
      const id = s.chaos.skipIds ? n * 2 : n;
      if (!s.send({ id, event, data: { n, time: new Date().toISOString() } })) return;
      n += 1;
    };
    tick();
    s.timers.push(setInterval(tick, interval));
  });

  r.post('/stream', ...stack, async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const words = int(b.words ?? req.query.words, 40, 1, 5000);
    const delayMs = int(b.delayMs ?? req.query.delayMs, 40, 0, 5000);
    const format = String(b.format ?? req.query.format ?? 'events');
    if (!['events', 'openai'].includes(format)) throw new HttpError(400, 'format must be "events" or "openai"', { code: 'invalid-parameter' });
    if (b.prompt !== undefined && typeof b.prompt !== 'string') throw new HttpError(422, '"prompt" must be a string', { code: 'validation-failed', errors: [{ field: 'prompt', message: 'must be a string' }] });
    const tokens = await streamText(ctx, b.prompt, words);
    const s = openStream(req, res, settings);
    const id = `cmpl-${crypto.randomBytes(8).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    let i = 0;
    const next = () => {
      if (s.closed) return;
      if (i >= tokens.length) {
        if (format === 'openai') {
          s.send({ data: { id, object: 'chat.completion.chunk', created, model: 'api-test-tool-mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } });
          s.end({ data: '[DONE]' });
        } else s.end({ event: 'done', id: i + 1, data: { id, words: tokens.length, finishReason: 'stop' } });
        return;
      }
      const delta = `${tokens[i]}${i < tokens.length - 1 ? ' ' : ''}`;
      const ok = format === 'openai'
        ? s.send({ data: { id, object: 'chat.completion.chunk', created, model: 'api-test-tool-mock', choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: delta } : { content: delta }, finish_reason: null }] } })
        : s.send({ event: 'message', id: i + 1, data: { index: i, delta } });
      if (!ok) return;
      i += 1;
      const t = setTimeout(next, delayMs);
      s.onClose.push(() => clearTimeout(t));
    };
    next();
  });

  r.all(['/changes', '/ticks', '/stream'], (req) => { throw new HttpError(405, `${req.method} is not supported on ${req.originalUrl.split('?')[0]}`, { code: 'method-not-allowed' }); });
  r.use((req) => { throw new HttpError(404, `No SSE route ${req.method} ${req.originalUrl}`, { code: 'route-not-found' }); });
  return r;
};

module.exports.frame = frame;
