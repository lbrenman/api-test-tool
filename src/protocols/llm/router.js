'use strict';
// /llm — an OpenAI-compatible mock LLM. Point any OpenAI SDK or connector at base URL <base>/llm/v1.
//
//   GET  /llm                          what is served (JSON, open)
//   GET  /llm/v1/models                model list (LLM_MODELS)
//   GET  /llm/v1/models/{id}           one model (404 model_not_found)
//   POST /llm/v1/chat/completions      chat completion, or a stream of chat.completion.chunk with stream: true
//   POST /llm/v1/embeddings            deterministic unit vectors (float or base64)
//
// Answers are vague, plausible prose (or JSON for response_format, or tool calls when tools are given).
// usage reports prompt tokens estimated from the request (about 4 characters per token, plus per-message
// overhead) and a random number of completion tokens between LLM_COMPLETION_TOKENS_MIN and _MAX, capped by
// max_tokens / max_completion_tokens (finish_reason "length"). A request `seed` makes the answer and the
// counts repeatable.
//
// Requests go through the shared protocol stack (AUTH_MODE, rate limit, required headers, chaos); errors are
// OpenAI-shaped ({"error": {message, type, param, code}}). Stream-level failures are opt-in per request:
//   X-Force-Stream-Drop: N    the connection is cut after N chunks
//   X-Force-Stream-Error: N   an error object is sent as the data of chunk N+1 and the stream ends without [DONE]
require('./errors');
const express = require('express');
const { HttpError, sendProblem } = require('../../util/problem');
const { protocolStack } = require('../../middleware/protocol');
const { verify, JSON_TYPES } = require('../../middleware/body');
const G = require('./generate');

const MODEL_CREATED = 1767225600; // 2026-01-01T00:00:00Z
const ROLES = ['system', 'developer', 'user', 'assistant', 'tool', 'function'];
const EFFORT = { minimal: [0, 0], low: [64, 256], medium: [256, 1024], high: [1024, 4096] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (field, message) => ({ field, message });

function models(settings) {
  return String(settings.get('llmModels') || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function modelObject(id) {
  return { id, object: 'model', created: MODEL_CREATED, owned_by: 'api-test-tool' };
}

function checkModel(settings, model) {
  if (settings.get('llmRequireKnownModel') && !models(settings).includes(model)) {
    throw new HttpError(404, `The model \`${model}\` does not exist or you do not have access to it.`, { code: 'model_not_found' });
  }
}

const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function validateChat(b) {
  const errs = [];
  if (typeof b.model !== 'string' || !b.model) errs.push(bad('model', 'you must provide a model parameter'));
  if (!Array.isArray(b.messages) || !b.messages.length) errs.push(bad('messages', 'must be a non-empty array'));
  else {
    b.messages.forEach((m, i) => {
      if (!m || typeof m !== 'object') { errs.push(bad(`messages[${i}]`, 'must be an object')); return; }
      if (!ROLES.includes(m.role)) errs.push(bad(`messages[${i}].role`, `must be one of ${ROLES.join(', ')}`));
      const c = m.content;
      const okContent = c === undefined || c === null || typeof c === 'string' || Array.isArray(c);
      if (!okContent) errs.push(bad(`messages[${i}].content`, 'must be a string, an array of content parts or null'));
      if ((c === undefined || c === null) && m.role !== 'assistant') errs.push(bad(`messages[${i}].content`, 'is required for this role'));
      if (m.role === 'tool' && typeof m.tool_call_id !== 'string') errs.push(bad(`messages[${i}].tool_call_id`, 'is required for tool messages'));
    });
  }
  const range = (name, lo, hi, int) => {
    const v = b[name];
    if (v === undefined || v === null) return;
    if (int ? !isInt(v) : !isNum(v)) errs.push(bad(name, `must be ${int ? 'an integer' : 'a number'}`));
    else if (v < lo || v > hi) errs.push(bad(name, `must be between ${lo} and ${hi}`));
  };
  range('temperature', 0, 2);
  range('top_p', 0, 1);
  range('presence_penalty', -2, 2);
  range('frequency_penalty', -2, 2);
  range('n', 1, 8, true);
  range('max_tokens', 1, 1000000, true);
  range('max_completion_tokens', 1, 1000000, true);
  range('top_logprobs', 0, 20, true);
  if (b.stream !== undefined && typeof b.stream !== 'boolean') errs.push(bad('stream', 'must be a boolean'));
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools)) errs.push(bad('tools', 'must be an array'));
    else {
      b.tools.forEach((t, i) => {
        if (!t || t.type !== 'function' || !t.function || typeof t.function.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.function.name)) {
          errs.push(bad(`tools[${i}]`, 'must be {"type": "function", "function": {"name": "<a-zA-Z0-9_- up to 64>", "parameters": {...}}}'));
        }
      });
    }
  }
  const tc = b.tool_choice;
  if (tc !== undefined && tc !== null) {
    const names = Array.isArray(b.tools) ? b.tools.map((t) => t?.function?.name) : [];
    if (typeof tc === 'string') {
      if (!['none', 'auto', 'required'].includes(tc)) errs.push(bad('tool_choice', 'must be none, auto, required or {"type": "function", "function": {"name": …}}'));
      else if (tc === 'required' && !names.length) errs.push(bad('tool_choice', '"required" needs at least one tool'));
    } else if (tc.type !== 'function' || !names.includes(tc.function?.name)) {
      errs.push(bad('tool_choice', 'must name one of the tools'));
    }
  }
  const rf = b.response_format;
  if (rf !== undefined && rf !== null) {
    if (!['text', 'json_object', 'json_schema'].includes(rf.type)) errs.push(bad('response_format.type', 'must be text, json_object or json_schema'));
    else if (rf.type === 'json_schema' && (!rf.json_schema || typeof rf.json_schema.name !== 'string')) errs.push(bad('response_format.json_schema', 'must include a name and a schema'));
  }
  if (b.reasoning_effort !== undefined && !EFFORT[b.reasoning_effort]) errs.push(bad('reasoning_effort', `must be one of ${Object.keys(EFFORT).join(', ')}`));
  if (b.stop !== undefined && b.stop !== null && typeof b.stop !== 'string' && !(Array.isArray(b.stop) && b.stop.length <= 4 && b.stop.every((s) => typeof s === 'string'))) {
    errs.push(bad('stop', 'must be a string or an array of up to 4 strings'));
  }
  if (errs.length) throw new HttpError(400, errs.length === 1 ? `Invalid value for '${errs[0].field}': ${errs[0].message}.` : 'Invalid request body.', { errors: errs });
}

function cutWords(text, tokens) {
  const words = Math.max(0, Math.round(tokens * 0.75));
  return text.split(/\s+/).slice(0, words).join(' ');
}

function applyStop(text, stop) {
  const list = stop === undefined || stop === null ? [] : [].concat(stop);
  let at = -1;
  for (const s of list) {
    const i = s ? text.indexOf(s) : -1;
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  return at >= 0 ? text.slice(0, at) : null;
}

/** Builds every choice and the usage block for a chat request. Pure apart from the RNG. */
function buildCompletion(settings, b) {
  const rng = G.makeRng(b.seed);
  const n = b.n || 1;
  const maxTokens = b.max_completion_tokens ?? b.max_tokens;
  const lo = settings.get('llmCompletionTokensMin');
  const hi = Math.max(lo, settings.get('llmCompletionTokensMax'));
  const prompt = G.lastUserText(b.messages);
  const promptTokens = G.promptTokens(b, rng);
  const [rlo, rhi] = EFFORT[b.reasoning_effort] || [0, 0];
  const tools = Array.isArray(b.tools) ? b.tools : [];
  const last = b.messages[b.messages.length - 1];
  const tc = b.tool_choice;
  const forced = tc && typeof tc === 'object' ? tc.function.name : null;
  const json = b.response_format?.type === 'json_object' || b.response_format?.type === 'json_schema';

  const choices = [];
  let completionTokens = 0;
  let reasoningTokens = 0;
  for (let index = 0; index < n; index += 1) {
    const reasoning = rlo || rhi ? rng.int(rlo, rhi) : 0;
    reasoningTokens += reasoning;
    const callTools = tools.length && tc !== 'none' && last?.role !== 'tool'
      && (forced || tc === 'required' || rng() * 100 < settings.get('llmToolCallRate'));
    if (callTools) {
      const picks = forced ? [tools.find((t) => t.function.name === forced)]
        : [rng.pick(tools), ...(b.parallel_tool_calls !== false && tools.length > 1 && rng() < 0.25 ? [rng.pick(tools)] : [])];
      const toolCalls = picks.map((t) => {
        const params = t.function.parameters && typeof t.function.parameters === 'object' ? t.function.parameters : { type: 'object', properties: {} };
        return { id: `call_${rng.id(24)}`, type: 'function', function: { name: t.function.name, arguments: JSON.stringify(G.fromSchema(params, params, rng)) } };
      });
      const tokens = 8 + toolCalls.reduce((a, c) => a + G.tokensIn(c.function.name) + G.tokensIn(c.function.arguments), 0);
      completionTokens += tokens + reasoning;
      choices.push({ index, message: { role: 'assistant', content: null, tool_calls: toolCalls, refusal: null, annotations: [] }, logprobs: null, finish_reason: 'tool_calls' });
      continue;
    }
    let text;
    let tokens;
    if (json) {
      text = JSON.stringify(G.jsonAnswer(rng, b.response_format, prompt));
      tokens = G.tokensIn(text);
    } else {
      tokens = rng.int(lo, hi);
      text = G.prose(rng, tokens, prompt);
    }
    let finish = 'stop';
    const stopped = applyStop(text, b.stop);
    if (stopped !== null) { text = stopped; tokens = Math.min(tokens, G.tokensIn(text)); }
    if (maxTokens && tokens + reasoning > maxTokens) {
      tokens = Math.max(0, maxTokens - reasoning);
      text = json ? text.slice(0, tokens * 4) : cutWords(text, tokens);
      finish = 'length';
    }
    completionTokens += tokens + reasoning;
    const logprobs = b.logprobs ? {
      content: text.split(/(?<= )/).filter(Boolean).map((tok) => ({
        token: tok,
        logprob: Math.round(-rng() * 2.5 * 1e4) / 1e4,
        bytes: [...Buffer.from(tok)],
        top_logprobs: Array.from({ length: b.top_logprobs || 0 }, (_, k) => ({ token: k ? `${tok.trim()}${k}` : tok, logprob: Math.round((-rng() * 3 - k) * 1e4) / 1e4, bytes: null })),
      })),
      refusal: null,
    } : null;
    choices.push({ index, message: { role: 'assistant', content: text, refusal: null, annotations: [] }, logprobs, finish_reason: finish });
  }

  const cached = promptTokens >= 1024 && rng() < 0.5 ? Math.floor((promptTokens * rng()) / 128) * 128 : 0;
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cached, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: reasoningTokens, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  };
  return { rng, choices, usage };
}

// Mirror the shared rate limiter's RateLimit-* headers as the x-ratelimit-*-requests headers OpenAI clients read.
function openaiRateHeaders(req, res, next) {
  const orig = res.writeHead;
  res.writeHead = function writeHead(...args) {
    const limit = res.getHeader('RateLimit-Limit');
    if (limit !== undefined && !res.headersSent) {
      res.setHeader('x-ratelimit-limit-requests', String(limit));
      res.setHeader('x-ratelimit-remaining-requests', String(res.getHeader('RateLimit-Remaining') ?? ''));
      res.setHeader('x-ratelimit-reset-requests', `${res.getHeader('RateLimit-Reset') ?? 0}s`);
    }
    return orig.apply(this, args);
  };
  next();
}

function streamChaos(req) {
  const num = (h) => {
    const v = req.get(h);
    if (v === undefined) return 0;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 100000) throw new HttpError(400, `${h} must be a positive integer (number of chunks)`);
    return n;
  };
  return { drop: num('x-force-stream-drop'), error: num('x-force-stream-error') };
}

async function streamCompletion(req, res, settings, b, out, meta) {
  const chaos = streamChaos(req);
  const delay = settings.get('llmStreamDelayMs');
  const includeUsage = !!b.stream_options?.include_usage;
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (chaos.drop) res.setHeader('X-Chaos-Injected', `stream-drop=${chaos.drop}`);
  else if (chaos.error) res.setHeader('X-Chaos-Injected', `stream-error=${chaos.error}`);
  res.flushHeaders();
  req.socket.setNoDelay?.(true);

  let closed = false;
  res.on('close', () => { closed = true; });
  let sent = 0;
  const chunk = (choices, extra = {}) => ({ ...meta, object: 'chat.completion.chunk', choices, ...(includeUsage ? { usage: null } : {}), ...extra });
  // Returns false once the stream has ended (client gone or chaos).
  const send = async (obj) => {
    if (closed) return false;
    if (chaos.error && sent === chaos.error) {
      res.end(`data: ${JSON.stringify({ error: { message: 'The server had an error while processing your request. (injected)', type: 'server_error', param: null, code: 'server_error' } })}\n\n`);
      closed = true;
      return false;
    }
    sent += 1;
    const text = `data: ${JSON.stringify(obj)}\n\n`;
    if (chaos.drop && sent >= chaos.drop) {
      closed = true;
      res.write(text, () => res.socket?.destroy());
      return false;
    }
    res.write(text);
    if (delay) await sleep(delay);
    return true;
  };

  for (const c of out.choices) {
    const msg = c.message;
    if (msg.tool_calls) {
      for (let k = 0; k < msg.tool_calls.length; k += 1) {
        const call = msg.tool_calls[k];
        const head = { index: k, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } };
        if (!await send(chunk([{ index: c.index, delta: k === 0 ? { role: 'assistant', content: null, tool_calls: [head] } : { tool_calls: [head] }, logprobs: null, finish_reason: null }]))) return;
        for (const part of call.function.arguments.match(/[\s\S]{1,12}/g) || []) {
          if (!await send(chunk([{ index: c.index, delta: { tool_calls: [{ index: k, function: { arguments: part } }] }, logprobs: null, finish_reason: null }]))) return;
        }
      }
    } else {
      if (!await send(chunk([{ index: c.index, delta: { role: 'assistant', content: '', refusal: null }, logprobs: null, finish_reason: null }]))) return;
      const pieces = msg.content ? msg.content.split(/(?<= )/) : [];
      for (let i = 0; i < pieces.length; i += 1) {
        const lp = c.logprobs ? { content: [c.logprobs.content[i]].filter(Boolean), refusal: null } : null;
        if (!await send(chunk([{ index: c.index, delta: { content: pieces[i] }, logprobs: lp, finish_reason: null }]))) return;
      }
    }
    if (!await send(chunk([{ index: c.index, delta: {}, logprobs: null, finish_reason: c.finish_reason }]))) return;
  }
  if (includeUsage && !await send(chunk([], { usage: out.usage }))) return;
  if (!closed) res.end('data: [DONE]\n\n');
}

module.exports = function llmRouter(ctx) {
  const { settings, baseUrl } = ctx;
  const r = express.Router();

  r.use((req, res, next) => {
    req.errorFormat = 'openai';
    if (!settings.get('llmEnabled')) return sendProblem(req, res, 404, { detail: 'The LLM mock is disabled (LLM_ENABLED=false)', code: 'llm_disabled' });
    next();
  });

  r.get('/', (req, res) => {
    const b = `${baseUrl(req)}/llm/v1`;
    res.json({
      baseUrl: b,
      endpoints: [
        { method: 'GET', url: `${b}/models`, description: 'Model list (LLM_MODELS).' },
        { method: 'POST', url: `${b}/chat/completions`, description: 'Chat completions: vague prose, JSON for response_format, tool calls when tools are given; stream: true for chat.completion.chunk events.' },
        { method: 'POST', url: `${b}/embeddings`, description: 'Deterministic unit vectors (dimensions, encoding_format float | base64).' },
      ],
      models: models(settings),
      completionTokens: [settings.get('llmCompletionTokensMin'), settings.get('llmCompletionTokensMax')],
      toolCallRate: settings.get('llmToolCallRate'),
      chaos: 'X-Force-Stream-Drop: N, X-Force-Stream-Error: N (streams); X-Force-Error and the other chaos headers as on /v1',
    });
  });

  const v1 = express.Router();
  v1.use(openaiRateHeaders);
  v1.use(...protocolStack(ctx, { format: 'openai', body: express.json({ limit: '20mb', type: JSON_TYPES, verify }) }));
  v1.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is(JSON_TYPES)) {
      return sendProblem(req, res, 400, { detail: 'Content-Type must be application/json', code: 'invalid_content_type' });
    }
    if (req.method === 'POST' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
      return sendProblem(req, res, 400, { detail: 'The request body must be a JSON object.' });
    }
    next();
  });

  v1.get('/models', (req, res) => res.json({ object: 'list', data: models(settings).map(modelObject) }));
  v1.get('/models/:id', (req, res) => {
    if (!models(settings).includes(req.params.id)) throw new HttpError(404, `The model \`${req.params.id}\` does not exist or you do not have access to it.`, { code: 'model_not_found' });
    res.json(modelObject(req.params.id));
  });

  v1.post('/chat/completions', async (req, res) => {
    const b = req.body;
    validateChat(b);
    checkModel(settings, b.model);
    const started = Date.now();
    const out = buildCompletion(settings, b);
    const meta = {
      id: `chatcmpl-${out.rng.id(29)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: b.model,
      service_tier: 'default',
      system_fingerprint: `fp_mock${out.rng.hex(6)}`,
    };
    res.setHeader('openai-processing-ms', String(Date.now() - started));
    if (b.stream) return streamCompletion(req, res, settings, b, out, meta);
    res.json({ ...meta, choices: out.choices, usage: out.usage });
  });

  v1.post('/embeddings', (req, res) => {
    const b = req.body;
    const errs = [];
    if (typeof b.model !== 'string' || !b.model) errs.push(bad('model', 'you must provide a model parameter'));
    let inputs = b.input;
    const tokenArray = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => Number.isInteger(x));
    if (typeof inputs === 'string' || tokenArray(inputs)) inputs = [inputs];
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 2048 || !inputs.every((x) => (typeof x === 'string' && x.length) || tokenArray(x))) {
      errs.push(bad('input', 'must be a non-empty string, an array of up to 2048 non-empty strings, or token arrays'));
    }
    const dims = b.dimensions ?? 1536;
    if (!isInt(dims) || dims < 1 || dims > 4096) errs.push(bad('dimensions', 'must be an integer between 1 and 4096'));
    const enc = b.encoding_format ?? 'float';
    if (!['float', 'base64'].includes(enc)) errs.push(bad('encoding_format', 'must be float or base64'));
    if (errs.length) throw new HttpError(400, errs.length === 1 ? `Invalid value for '${errs[0].field}': ${errs[0].message}.` : 'Invalid request body.', { errors: errs });
    checkModel(settings, b.model);
    let tokens = 0;
    const data = inputs.map((x, index) => {
      const text = typeof x === 'string' ? x : x.join(',');
      tokens += typeof x === 'string' ? G.tokensIn(x) : x.length;
      const vec = G.embedding(text, dims);
      let embedding = vec;
      if (enc === 'base64') {
        const buf = Buffer.alloc(dims * 4);
        vec.forEach((v, i) => buf.writeFloatLE(v, i * 4));
        embedding = buf.toString('base64');
      }
      return { object: 'embedding', index, embedding };
    });
    res.json({ object: 'list', data, model: b.model, usage: { prompt_tokens: tokens, total_tokens: tokens } });
  });

  v1.all(['/models', '/models/:id', '/chat/completions', '/embeddings'], (req) => {
    throw new HttpError(405, `${req.method} is not supported on ${req.originalUrl.split('?')[0]}`, { code: 'method_not_allowed' });
  });
  v1.use((req) => { throw new HttpError(404, `Unknown request URL: ${req.method} ${req.originalUrl.split('?')[0]}. Supported: GET /models, POST /chat/completions, POST /embeddings.`, { code: 'unknown_url' }); });

  r.use('/v1', v1);
  r.use((req) => { throw new HttpError(404, `No LLM route ${req.method} ${req.originalUrl.split('?')[0]}. The OpenAI-compatible base URL is /llm/v1.`, { code: 'unknown_url' }); });
  return r;
};

module.exports.buildCompletion = buildCompletion;
