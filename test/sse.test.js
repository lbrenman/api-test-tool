'use strict';
// Server-Sent Events: /sse/changes (live feed, Last-Event-ID replay, reset), /sse/ticks, POST /sse/stream,
// the shared stack (auth incl. ?access_token=, chaos), per-stream chaos, heartbeats, and the tester's
// handling of streaming responses.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { listen } = require('./helpers');

let t;
before(async () => { t = await listen({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.stop(); });

const api = () => request(t.app);
const set = (k, v) => t.ctx.settings.set(k, v);

function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const ev = { data: [] };
    let any = false;
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'data') ev.data.push(value);
      else if (field === 'id' || field === 'event' || field === 'retry') ev[field] = value;
      any = true;
    }
    if (any && ev.data.length) events.push({ ...ev, data: ev.data.join('\n') });
  }
  return events;
}

const asText = (res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d)); };

// An incrementally-read stream.
function stream(path, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${t.url}${path}`, { method, headers }, (res) => {
      const s = { status: res.statusCode, headers: res.headers, text: '', ended: false };
      const waiters = [];
      const wake = () => waiters.splice(0).forEach((f) => f());
      res.setEncoding('utf8');
      res.on('data', (c) => { s.text += c; wake(); });
      const fin = () => { s.ended = true; wake(); };
      res.on('end', fin); res.on('aborted', fin); res.on('close', fin); res.on('error', fin);
      s.events = () => parseSse(s.text);
      s.until = (pred, ms = 4000) => new Promise((ok, no) => {
        const tm = setTimeout(() => no(new Error(`timed out; got:\n${s.text.slice(-400)}`)), ms);
        const check = () => {
          if (pred(s)) { clearTimeout(tm); ok(s); return; }
          if (s.ended) { clearTimeout(tm); no(new Error(`stream ended; got:\n${s.text.slice(-400)}`)); return; }
          waiters.push(check);
        };
        check();
      });
      s.close = () => req.destroy();
      resolve(s);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('stream list and ticks: count, ids, retry, end event, Last-Event-ID resume', async () => {
  const list = (await api().get('/sse').expect(200)).body;
  assert.deepEqual(list.streams.map((x) => x.name), ['changes', 'ticks', 'stream']);

  const r = await api().get('/sse/ticks?interval=50&count=3').buffer(true).parse(asText).expect(200);
  assert.match(r.get('Content-Type'), /^text\/event-stream/);
  assert.equal(r.get('Cache-Control'), 'no-cache, no-transform');
  assert.match(r.body, /^retry: 3000\n\n/);
  const evs = parseSse(r.body);
  assert.deepEqual(evs.map((e) => `${e.event}:${e.id ?? ''}`), ['tick:1', 'tick:2', 'tick:3', 'end:']);
  assert.equal(JSON.parse(evs[0].data).n, 1);

  const resumed = parseSse((await api().get('/sse/ticks?interval=50&count=5').set('Last-Event-ID', '3').buffer(true).parse(asText).expect(200)).body);
  assert.deepEqual(resumed.filter((e) => e.event === 'tick').map((e) => e.id), ['4', '5']);
});

test('POST /sse/stream: event and OpenAI chunk formats', async () => {
  const a = parseSse((await api().post('/sse/stream').send({ prompt: 'Who works here?', words: 6, delayMs: 5 }).buffer(true).parse(asText).expect(200)).body);
  const msgs = a.filter((e) => e.event === 'message');
  assert.equal(msgs.length, 6);
  assert.equal(JSON.parse(msgs[0].data).delta, 'You ');
  assert.equal(JSON.parse(a[a.length - 1].data).finishReason, 'stop');

  const o = parseSse((await api().post('/sse/stream').send({ words: 3, delayMs: 0, format: 'openai' }).buffer(true).parse(asText).expect(200)).body);
  assert.equal(o[o.length - 1].data, '[DONE]');
  const first = JSON.parse(o[0].data);
  assert.equal(first.object, 'chat.completion.chunk');
  assert.equal(first.choices[0].delta.role, 'assistant');
  assert.equal(JSON.parse(o[o.length - 2].data).choices[0].finish_reason, 'stop');

  await api().post('/sse/stream').send({ format: 'xml' }).expect(400);
  await api().post('/sse/stream').send({ prompt: 5 }).expect(422);
});

test('changes: live events from /v1, and Last-Event-ID replays what was missed', async () => {
  const s = await stream('/sse/changes?resource=departments');
  assert.equal(s.status, 200);
  await s.until((x) => x.events().some((e) => e.event === 'subscribed'));
  const d1 = (await api().post('/v1/departments').send({ name: 'SSE One', code: 'SSE1' }).expect(201)).body;
  await s.until((x) => x.events().some((e) => e.event === 'created'));
  const created = s.events().find((e) => e.event === 'created');
  assert.equal(JSON.parse(created.data).id, d1.id);
  const lastId = created.id;
  s.close();

  const d2 = (await api().post('/v1/departments').send({ name: 'SSE Two', code: 'SSE2' }).expect(201)).body;
  await api().patch(`/v1/products/1`).set('Content-Type', 'application/merge-patch+json').send({ stockQty: 7 }).expect(200); // filtered out
  const again = await stream('/sse/changes?resource=departments', { headers: { 'Last-Event-ID': lastId } });
  await again.until((x) => x.events().some((e) => e.event === 'created'));
  const replay = again.events();
  assert.ok(!replay.some((e) => e.event === 'subscribed'), 'a resumed stream does not resubscribe');
  assert.equal(JSON.parse(replay.find((e) => e.event === 'created').data).id, d2.id);
  again.close();
  for (const d of [d1, d2]) await api().delete(`/v1/departments/${d.id}`).expect(204);
});

test('changes: an id older than the replay buffer gets event: reset', async () => {
  await set('sseReplayBuffer', 1);
  try {
    for (let i = 0; i < 3; i++) await api().patch('/v1/products/2').set('Content-Type', 'application/merge-patch+json').send({ stockQty: i }).expect(200);
    const s = await stream('/sse/changes?lastEventId=0');
    await s.until((x) => x.events().length >= 2);
    const evs = s.events();
    assert.equal(evs[0].event, 'reset');
    assert.equal(evs[1].event, 'updated');
    s.close();
  } finally { await set('sseReplayBuffer', 500); }
});

test('auth (header or ?access_token=), chaos before and during the stream, heartbeats, errors', async () => {
  await set('authMode', 'bearer');
  try {
    await api().get('/sse/ticks?count=1&interval=50').expect(401);
    await api().get('/sse/ticks?count=1&interval=50&access_token=demo-token').expect(200);
    await api().get('/sse/ticks?count=1&interval=50').set('Authorization', 'Bearer demo-token').expect(200);
    await api().get('/v1/employees/1?access_token=demo-token').expect(401); // query tokens are for streams only
  } finally { await set('authMode', 'none'); }

  const forced = await api().get('/sse/ticks').set('X-Force-Error', '503').expect(503);
  assert.match(forced.get('Content-Type'), /problem\+json/);

  const dropped = await stream('/sse/ticks?interval=50&dropAfter=2');
  assert.equal(dropped.headers['x-chaos-injected'], 'dropAfter=2');
  await dropped.until((x) => x.ended, 3000);
  assert.equal(dropped.events().filter((e) => e.event === 'tick').length, 2);

  const broken = await api().get('/sse/ticks?interval=50&count=2&malformedAt=1').buffer(true).parse(asText).expect(200);
  assert.match(broken.body, /data: \{"broken": \n/);

  await set('sseHeartbeatSeconds', 1);
  try {
    const hb = await stream('/sse/ticks?interval=60000');
    await hb.until((x) => /\n: keepalive /.test(x.text), 3000);
    hb.close();
  } finally { await set('sseHeartbeatSeconds', 15); }

  await api().get('/sse/changes?resource=widgets').expect(400);
  await api().post('/sse/changes').expect(405);
  await api().get('/sse/nope').expect(404);
  await set('sseEnabled', false);
  try { await api().get('/sse/ticks?count=1').expect(404); } finally { await set('sseEnabled', true); }
});

test('the data spec documents the streams; the tester reads a stream for a time window', async () => {
  const doc = (await api().get('/openapi.json').expect(200)).body;
  assert.ok(doc.paths['/sse/changes'].get.responses['200'].content['text/event-stream']);
  assert.ok(doc.paths['/sse/stream'].post);

  const c = (await api().post('/admin/api/tester/specs').send({ sample: 'self' }).expect(201)).body;
  await api().put(`/admin/api/tester/specs/${c.id}`).send({ target: { baseUrl: t.url, streamReadMs: 500 } }).expect(200);
  const started = Date.now();
  const r = (await api().post(`/admin/api/tester/specs/${c.id}/send`).send({ opId: 'GET /sse/changes' }).expect(200)).body;
  assert.ok(Date.now() - started < 5000, 'did not wait for the endless stream');
  assert.equal(r.response.status, 200);
  assert.equal(r.response.streamed, true);
  assert.match(r.response.body, /event: subscribed/);
  assert.equal(r.outcome, 'pass', JSON.stringify(r.checks));
});
