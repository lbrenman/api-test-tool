'use strict';
// Protocol-aware error rendering + the shared protocol middleware stack (middleware/protocol.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { registerErrorRenderer, sendProblem, errorFormats } = require('../src/util/problem');
const { protocolStack } = require('../src/middleware/protocol');

// A throwaway XML renderer standing in for a future SOAP/OData module.
registerErrorRenderer('test-xml', (p) => ({
  status: p.status,
  contentType: 'application/xml',
  body: `<error status="${p.status}" code="${p.code || ''}" requestId="${p.requestId}">${p.detail}</error>`,
  headers: { 'X-Error-Format': 'test-xml' },
}));

let t;
let mini; // a second "protocol surface" sharing the main app's context

before(async () => {
  t = await makeApp({ SEED_SAMPLE_FILES: 'false' });
  mini = express();
  mini.locals.ctx = t.ctx;
  mini.set('trust proxy', true);
  const r = express.Router();
  r.use(...protocolStack(t.ctx, { format: 'test-xml', body: express.text({ type: '*/*' }) }));
  r.get('/ping', (req, res) => res.type('application/xml').send('<pong/>'));
  r.post('/fail', (req, res) => sendProblem(req, res, 422, { detail: 'bad payload', code: 'bad-payload' }));
  mini.use('/proto', r);
});

after(async () => {
  await t.close();
});

async function setSetting(key, value) {
  await t.ctx.settings.set(key, value);
}

test('problem+json stays the default for /v1', async () => {
  const r = await request(t.app).get('/v1/employees/1').set('X-Force-Error', '503').expect(503);
  assert.match(r.get('Content-Type'), /application\/problem\+json/);
  assert.equal(r.body.status, 503);
  assert.ok(errorFormats().includes('problem'));
});

test('a protocol surface renders chaos errors in its own format', async () => {
  const ok = await request(mini).get('/proto/ping').expect(200);
  assert.match(ok.text, /<pong\/>/);
  const r = await request(mini).get('/proto/ping').set('X-Force-Error', '503').expect(503);
  assert.match(r.get('Content-Type'), /application\/xml/);
  assert.equal(r.get('X-Error-Format'), 'test-xml');
  assert.equal(r.get('X-Chaos-Injected'), '503');
  assert.equal(r.get('Retry-After'), '5');
  assert.match(r.text, /<error status="503" code="chaos-injected"/);
});

test('handler errors and auth failures use the protocol format, keeping challenge headers', async () => {
  const r = await request(mini).post('/proto/fail').set('Content-Type', 'text/plain').send('x').expect(422);
  assert.match(r.text, /code="bad-payload"/);
  await setSetting('authMode', 'basic');
  try {
    const u = await request(mini).get('/proto/ping').expect(401);
    assert.match(u.get('Content-Type'), /application\/xml/);
    assert.match(u.get('WWW-Authenticate'), /^Basic /);
    await request(mini).get('/proto/ping').auth('demo', 'demo').expect(200);
  } finally {
    await setSetting('authMode', 'none');
  }
});

test('the rate limit is one budget shared across protocol surfaces', async () => {
  await setSetting('rateLimitRpm', 2);
  try {
    // The main app's /v1 stack and the mini surface share ctx, so they share the limiter.
    const a = await request(t.app).get('/v1/employees/1');
    const b = await request(mini).get('/proto/ping');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const c = await request(mini).get('/proto/ping').expect(429);
    assert.match(c.get('Content-Type'), /application\/xml/);
    assert.ok(c.get('Retry-After'));
    const d = await request(t.app).get('/v1/employees/1').expect(429);
    assert.match(d.get('Content-Type'), /application\/problem\+json/);
  } finally {
    await setSetting('rateLimitRpm', 0);
  }
});

test('protocolStack rejects an unregistered error format', () => {
  assert.throws(() => protocolStack(t.ctx, { format: 'nope' }), /Unknown error format/);
});
