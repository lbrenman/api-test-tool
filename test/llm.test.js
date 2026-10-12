'use strict';
// Mock LLM (/llm/v1, OpenAI-compatible): chat completions (usage, seed, max_tokens, n, reasoning, tools, JSON
// output), streaming (chunks, usage chunk, [DONE], stream chaos), embeddings, models, OpenAI-shaped errors,
// the shared stack (auth, chaos, rate-limit headers) and the inspector source.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { listen } = require('./helpers');
const { apiKind } = require('../src/middleware/inspector');

let t;
before(async () => { t = await listen({ SEED_SAMPLE_FILES: 'false' }); });
after(async () => { await t.stop(); });

const api = () => request(t.app);
const set = (k, v) => t.ctx.settings.set(k, v);
const reset = async (keys) => { for (const key of keys) await t.ctx.settings.reset({ key }); };
const chat = (body, headers = {}) => api().post('/llm/v1/chat/completions').set(headers).send({ model: 'mock-chat-large', ...body });
const user = (content) => [{ role: 'user', content }];

function assertOpenAIError(res, status, code) {
  assert.equal(res.status, status);
  assert.match(res.get('Content-Type'), /application\/json/);
  const e = res.body.error;
  assert.ok(e && typeof e.message === 'string' && typeof e.type === 'string', JSON.stringify(res.body));
  assert.ok('param' in e && 'code' in e);
  if (code !== undefined) assert.equal(e.code, code);
  return e;
}

// Reads a whole streamed response as SSE data payloads.
function streamChat(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: 'mock-chat-large', stream: true, ...body });
    const req = http.request(`${t.url}/llm/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      const done = (aborted) => {
        const data = text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => b.slice(6));
        resolve({ status: res.statusCode, headers: res.headers, text, data, aborted, chunks: data.filter((d) => d !== '[DONE]').map((d) => JSON.parse(d)) });
      };
      res.on('end', () => done(false));
      res.on('aborted', () => done(true));
      res.on('error', () => done(true));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('listing, models and the inspector source', async () => {
  const info = (await api().get('/llm').expect(200)).body;
  assert.match(info.baseUrl, /\/llm\/v1$/);
  assert.ok(info.models.includes('mock-chat-large'));
  const models = (await api().get('/llm/v1/models').expect(200)).body;
  assert.equal(models.object, 'list');
  assert.deepEqual(models.data[0], { id: 'mock-chat-large', object: 'model', created: models.data[0].created, owned_by: 'api-test-tool' });
  assert.equal((await api().get('/llm/v1/models/mock-chat-small').expect(200)).body.id, 'mock-chat-small');
  assertOpenAIError(await api().get('/llm/v1/models/nope'), 404, 'model_not_found');
  assert.equal(apiKind('/llm/v1/chat/completions'), 'llm');
  const health = (await api().get('/health').expect(200)).body;
  assert.ok(health.settings.llm.baseUrl.endsWith('/llm/v1'));
});

test('a chat completion has the OpenAI shape and usage that adds up', async () => {
  const r = await chat({ messages: [{ role: 'system', content: 'Be brief.' }, ...user('What should we do next quarter?')] }).expect(200);
  const b = r.body;
  assert.match(b.id, /^chatcmpl-/);
  assert.equal(b.object, 'chat.completion');
  assert.equal(b.model, 'mock-chat-large');
  assert.ok(Number.isInteger(b.created));
  assert.equal(b.choices.length, 1);
  const c = b.choices[0];
  assert.equal(c.message.role, 'assistant');
  assert.ok(c.message.content.length > 10);
  assert.match(c.message.content, /[.!?]$/, 'whole sentences');
  assert.equal(c.finish_reason, 'stop');
  const u = b.usage;
  assert.equal(u.total_tokens, u.prompt_tokens + u.completion_tokens);
  assert.ok(u.completion_tokens >= 20 && u.completion_tokens <= 300, `completion tokens ${u.completion_tokens}`);
  assert.equal(u.completion_tokens_details.reasoning_tokens, 0);
  assert.ok(r.get('openai-processing-ms'));

  // Any model name is echoed back by default.
  assert.equal((await chat({ model: 'gpt-something', messages: user('hi') }).expect(200)).body.model, 'gpt-something');
});

test('prompt tokens follow the size of the request; completion tokens follow the settings', async () => {
  const small = (await chat({ seed: 1, messages: user('hi') }).expect(200)).body.usage.prompt_tokens;
  const big = (await chat({ seed: 1, messages: user('word '.repeat(2000)) }).expect(200)).body.usage.prompt_tokens;
  assert.ok(small < 20, `small prompt ${small}`);
  assert.ok(big > 2000 && big < 3000, `big prompt ${big}`);

  await set('llmCompletionTokensMin', 50);
  await set('llmCompletionTokensMax', 50);
  try {
    const r = (await chat({ messages: user('hi') }).expect(200)).body;
    assert.equal(r.usage.completion_tokens, 50);
    const words = r.choices[0].message.content.split(/\s+/).length;
    assert.ok(words >= 22 && words <= 45, `about 0.75 words per token, got ${words}`);
  } finally {
    await reset(['llmCompletionTokensMin', 'llmCompletionTokensMax']);
  }
});

test('seed makes the answer repeatable; max_tokens, n and reasoning_effort shape the usage', async () => {
  const a = (await chat({ seed: 9, messages: user('hello') }).expect(200)).body;
  const b = (await chat({ seed: 9, messages: user('hello') }).expect(200)).body;
  assert.equal(a.choices[0].message.content, b.choices[0].message.content);
  assert.deepEqual(a.usage, b.usage);

  const cut = (await chat({ max_tokens: 7, messages: user('a long essay please') }).expect(200)).body;
  assert.equal(cut.choices[0].finish_reason, 'length');
  assert.equal(cut.usage.completion_tokens, 7);
  const cut2 = (await chat({ max_completion_tokens: 3, messages: user('x') }).expect(200)).body;
  assert.equal(cut2.usage.completion_tokens, 3);

  const many = (await chat({ n: 3, messages: user('x') }).expect(200)).body;
  assert.deepEqual(many.choices.map((c) => c.index), [0, 1, 2]);

  const reasoning = (await chat({ reasoning_effort: 'high', messages: user('think hard') }).expect(200)).body.usage;
  const r = reasoning.completion_tokens_details.reasoning_tokens;
  assert.ok(r >= 1024 && r <= 4096, `reasoning ${r}`);
  assert.ok(reasoning.completion_tokens > r);

  const stopped = (await chat({ seed: 9, stop: ['moving'], messages: user('hello') }).expect(200)).body;
  assert.ok(!stopped.choices[0].message.content.includes('moving'));

  const lp = (await chat({ logprobs: true, top_logprobs: 2, max_tokens: 10, messages: user('x') }).expect(200)).body.choices[0].logprobs;
  assert.ok(lp.content.length > 0);
  assert.equal(lp.content[0].top_logprobs.length, 2);
});

const weather = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }, days: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['city', 'unit', 'days'] } } };
const lookup = { type: 'function', function: { name: 'lookup_order', parameters: { type: 'object', properties: { orderId: { type: 'string', pattern: '^PO-[0-9]{10}$' } }, required: ['orderId'] } } };

test('tools: required and named choices call, none and tool results answer in text, auto follows the rate', async () => {
  const r = (await chat({ tools: [weather], tool_choice: 'required', messages: user('weather?') }).expect(200)).body;
  const c = r.choices[0];
  assert.equal(c.finish_reason, 'tool_calls');
  assert.equal(c.message.content, null);
  const call = c.message.tool_calls[0];
  assert.match(call.id, /^call_/);
  assert.equal(call.type, 'function');
  const args = JSON.parse(call.function.arguments);
  assert.equal(typeof args.city, 'string');
  assert.ok(['celsius', 'fahrenheit'].includes(args.unit));
  assert.ok(Number.isInteger(args.days) && args.days >= 1 && args.days <= 5);

  const named = (await chat({ tools: [weather, lookup], tool_choice: { type: 'function', function: { name: 'lookup_order' } }, messages: user('order?') }).expect(200)).body;
  const nc = named.choices[0].message.tool_calls;
  assert.equal(nc.length, 1);
  assert.match(JSON.parse(nc[0].function.arguments).orderId, /^PO-[0-9]{10}$/);

  assert.equal((await chat({ tools: [weather], tool_choice: 'none', messages: user('x') }).expect(200)).body.choices[0].finish_reason, 'stop');
  const afterTool = (await chat({ tools: [weather], tool_choice: 'auto', messages: [...user('weather?'), { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: '{"temp":18}' }] }).expect(200)).body;
  assert.equal(afterTool.choices[0].finish_reason, 'stop');

  await set('llmToolCallRate', 100);
  try {
    assert.equal((await chat({ tools: [weather], messages: user('x') }).expect(200)).body.choices[0].finish_reason, 'tool_calls');
    await set('llmToolCallRate', 0);
    assert.equal((await chat({ tools: [weather], messages: user('x') }).expect(200)).body.choices[0].finish_reason, 'stop');
  } finally {
    await reset(['llmToolCallRate']);
  }
});

test('response_format json_object and json_schema return JSON content', async () => {
  const obj = JSON.parse((await chat({ response_format: { type: 'json_object' }, messages: user('json please') }).expect(200)).body.choices[0].message.content);
  assert.equal(typeof obj.answer, 'string');
  const schema = { type: 'object', properties: { risk: { type: 'string', enum: ['low', 'medium', 'high'] }, score: { type: 'number', minimum: 0, maximum: 1 }, tags: { type: 'array', items: { type: 'string' } } }, required: ['risk', 'score', 'tags'], additionalProperties: false };
  const out = JSON.parse((await chat({ response_format: { type: 'json_schema', json_schema: { name: 'risk', strict: true, schema } }, messages: user('risk?') }).expect(200)).body.choices[0].message.content);
  assert.ok(['low', 'medium', 'high'].includes(out.risk));
  assert.ok(out.score >= 0 && out.score <= 1);
  assert.ok(Array.isArray(out.tags));
});

test('invalid requests get OpenAI-shaped 400s naming the parameter', async () => {
  assert.equal(assertOpenAIError(await api().post('/llm/v1/chat/completions').send({ messages: user('x') }), 400).param, 'model');
  assert.equal(assertOpenAIError(await chat({ messages: [] }), 400).param, 'messages');
  assert.equal(assertOpenAIError(await chat({ messages: [{ role: 'robot', content: 'x' }] }), 400).param, 'messages[0].role');
  assert.equal(assertOpenAIError(await chat({ temperature: 3, messages: user('x') }), 400).param, 'temperature');
  assert.equal(assertOpenAIError(await chat({ tools: [weather], tool_choice: { type: 'function', function: { name: 'other' } }, messages: user('x') }), 400).param, 'tool_choice');
  assert.equal(assertOpenAIError(await chat({ messages: [{ role: 'tool', content: 'x' }] }), 400).param, 'messages[0].tool_call_id');
  const e = assertOpenAIError(await api().post('/llm/v1/chat/completions').set('Content-Type', 'application/json').send('{"broken'), 400);
  assert.equal(e.type, 'invalid_request_error');
  assertOpenAIError(await api().post('/llm/v1/chat/completions').set('Content-Type', 'text/plain').send('hi'), 400);
  assertOpenAIError(await api().get('/llm/v1/chat/completions'), 405);
  assertOpenAIError(await api().get('/llm/v1/nothing'), 404, 'unknown_url');

  await set('llmRequireKnownModel', true);
  try {
    assertOpenAIError(await chat({ model: 'gpt-x', messages: user('x') }), 404, 'model_not_found');
    await chat({ model: 'mock-chat-small', messages: user('x') }).expect(200);
  } finally {
    await reset(['llmRequireKnownModel']);
  }
});

test('the shared stack: auth, chaos and rate-limit headers in OpenAI form', async () => {
  await set('authMode', 'bearer');
  try {
    const e = assertOpenAIError(await chat({ messages: user('x') }), 401, 'invalid_api_key');
    assert.equal(e.type, 'invalid_request_error');
    await chat({ messages: user('x') }, { Authorization: `Bearer ${t.ctx.settings.get('bearerToken')}` }).expect(200);
  } finally {
    await reset(['authMode']);
  }

  const err = assertOpenAIError(await api().get('/llm/v1/models').set('X-Force-Error', '503'), 503);
  assert.equal(err.type, 'server_error');
  const rl = await api().get('/llm/v1/models').set('X-Force-Error', '429');
  assertOpenAIError(rl, 429, 'rate_limit_exceeded');
  assert.equal(rl.get('Retry-After'), '5');

  await set('rateLimitRpm', 1000);
  try {
    const r = await api().get('/llm/v1/models').expect(200);
    assert.equal(r.get('x-ratelimit-limit-requests'), '1000');
    assert.ok(Number(r.get('x-ratelimit-remaining-requests')) < 1000);
    assert.match(r.get('x-ratelimit-reset-requests'), /^\d+s$/);
  } finally {
    await reset(['rateLimitRpm']);
  }

  await set('llmEnabled', false);
  try {
    assertOpenAIError(await api().get('/llm/v1/models'), 404, 'llm_disabled');
  } finally {
    await reset(['llmEnabled']);
  }
});

test('streaming: role first, content deltas, finish chunk, usage chunk and [DONE]; same text as unstreamed', async () => {
  await set('llmStreamDelayMs', 0);
  try {
    const s = await streamChat({ seed: 5, stream_options: { include_usage: true }, messages: user('hello') });
    assert.equal(s.status, 200);
    assert.match(s.headers['content-type'], /^text\/event-stream/);
    assert.equal(s.data[s.data.length - 1], '[DONE]');
    const chunks = s.chunks;
    assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk'));
    assert.equal(new Set(chunks.map((c) => c.id)).size, 1);
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    const text = chunks.flatMap((c) => c.choices).map((c) => c.delta.content || '').join('');
    const finish = chunks.flatMap((c) => c.choices).find((c) => c.finish_reason);
    assert.equal(finish.finish_reason, 'stop');
    const last = chunks[chunks.length - 1];
    assert.deepEqual(last.choices, []);
    assert.equal(last.usage.total_tokens, last.usage.prompt_tokens + last.usage.completion_tokens);
    assert.ok(chunks.slice(0, -1).every((c) => c.usage === null));

    const plain = (await chat({ seed: 5, messages: user('hello') }).expect(200)).body;
    assert.equal(text, plain.choices[0].message.content);
    assert.deepEqual(last.usage, plain.usage);

    // Without include_usage there is no usage field at all.
    const bare = await streamChat({ messages: user('x'), max_tokens: 4 });
    assert.ok(bare.chunks.every((c) => !('usage' in c)));
    assert.equal(bare.chunks.flatMap((c) => c.choices).find((c) => c.finish_reason).finish_reason, 'length');

    // Tool-call arguments arrive in fragments that join into JSON.
    const tc = await streamChat({ tools: [weather], tool_choice: 'required', messages: user('weather?') });
    const deltas = tc.chunks.flatMap((c) => c.choices).flatMap((c) => c.delta.tool_calls || []);
    assert.equal(deltas[0].function.name, 'get_weather');
    assert.match(deltas[0].id, /^call_/);
    const args = JSON.parse(deltas.map((d) => d.function.arguments || '').join(''));
    assert.equal(typeof args.city, 'string');
    assert.equal(tc.chunks.flatMap((c) => c.choices).find((c) => c.finish_reason).finish_reason, 'tool_calls');
  } finally {
    await reset(['llmStreamDelayMs']);
  }
});

test('stream chaos: a dropped connection and an error chunk', async () => {
  await set('llmStreamDelayMs', 0);
  try {
    const drop = await streamChat({ messages: user('x') }, { 'X-Force-Stream-Drop': '3' });
    assert.equal(drop.headers['x-chaos-injected'], 'stream-drop=3');
    assert.equal(drop.chunks.length, 3);
    assert.ok(!drop.text.includes('[DONE]'));

    const err = await streamChat({ messages: user('x') }, { 'X-Force-Stream-Error': '2' });
    assert.equal(err.data.length, 3);
    assert.equal(JSON.parse(err.data[2]).error.type, 'server_error');
    assert.ok(!err.text.includes('[DONE]'));

    assertOpenAIError(await chat({ stream: true, messages: user('x') }, { 'X-Force-Stream-Drop': 'lots' }), 400);
  } finally {
    await reset(['llmStreamDelayMs']);
  }
});

test('embeddings: deterministic unit vectors, dimensions and base64', async () => {
  const r = (await api().post('/llm/v1/embeddings').send({ model: 'mock-embed-small', input: ['alpha', 'beta', 'alpha'], dimensions: 16 }).expect(200)).body;
  assert.equal(r.object, 'list');
  assert.equal(r.data.length, 3);
  assert.equal(r.data[0].embedding.length, 16);
  assert.deepEqual(r.data[0].embedding, r.data[2].embedding);
  assert.notDeepEqual(r.data[0].embedding, r.data[1].embedding);
  const norm = Math.sqrt(r.data[1].embedding.reduce((a, v) => a + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-4);
  assert.ok(r.usage.prompt_tokens > 0);

  const def = (await api().post('/llm/v1/embeddings').send({ model: 'm', input: 'one' }).expect(200)).body;
  assert.equal(def.data[0].embedding.length, 1536);

  const b64 = (await api().post('/llm/v1/embeddings').send({ model: 'm', input: 'alpha', dimensions: 16, encoding_format: 'base64' }).expect(200)).body;
  const buf = Buffer.from(b64.data[0].embedding, 'base64');
  assert.equal(buf.length, 64);
  assert.ok(Math.abs(buf.readFloatLE(0) - r.data[0].embedding[0]) < 1e-6);

  const tokens = (await api().post('/llm/v1/embeddings').send({ model: 'm', input: [1, 2, 3] }).expect(200)).body;
  assert.equal(tokens.usage.prompt_tokens, 3);

  assert.equal(assertOpenAIError(await api().post('/llm/v1/embeddings').send({ model: 'm', input: '' }), 400).param, 'input');
  assert.equal(assertOpenAIError(await api().post('/llm/v1/embeddings').send({ model: 'm', input: 'x', dimensions: 0 }), 400).param, 'dimensions');
});
