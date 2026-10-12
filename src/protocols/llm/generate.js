'use strict';
// Content for the mock LLM: a seedable random generator, rough token counting, vague "assistant" prose,
// JSON values that fit a JSON Schema (tool-call arguments, json_schema response formats) and
// deterministic embeddings. Nothing here calls a real model.
const crypto = require('node:crypto');
const { fromPattern } = require('../../services/tester/sample');

// ---- random numbers ----------------------------------------------------------
// mulberry32: small, fast, good enough for test data. Seeded from the request's `seed` when given,
// so the same request with the same seed gets the same answer and the same token counts.
function makeRng(seed) {
  let a = seed === undefined || seed === null
    ? crypto.randomBytes(4).readUInt32LE(0)
    : (crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0));
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (min, max) => min + Math.floor(next() * (max - min + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.hex = (n) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join('');
  next.id = (n) => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(next() * 62)]).join('');
  return next;
}

// ---- token counting ------------------------------------------------------------
// About 4 characters per token for English text, the usual rule of thumb. Good enough to make the usage
// figures move with the size of the request, which is what an integration's cost tracking needs to see.
const tokensIn = (text) => (text ? Math.max(1, Math.ceil(String(text).length / 4)) : 0);

function contentText(content) {
  if (content === null || content === undefined) return { text: '', images: 0 };
  if (typeof content === 'string') return { text: content, images: 0 };
  let text = '';
  let images = 0;
  for (const part of Array.isArray(content) ? content : []) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') text += `${part.text}\n`;
    else if (part.type === 'image_url' || part.type === 'input_image') images += 1;
    else if (part.type === 'input_audio') images += 1;
  }
  return { text, images };
}

/** Prompt tokens for a chat request: per-message overhead + content + tools, with a little jitter. */
function promptTokens(body, rng) {
  let n = 3; // every reply is primed with a few tokens
  for (const m of body.messages || []) {
    const { text, images } = contentText(m.content);
    n += 4 + tokensIn(text) + tokensIn(m.name) + images * 85;
    if (Array.isArray(m.tool_calls)) n += tokensIn(JSON.stringify(m.tool_calls));
  }
  if (Array.isArray(body.tools) && body.tools.length) n += 10 + tokensIn(JSON.stringify(body.tools));
  if (body.response_format?.json_schema) n += tokensIn(JSON.stringify(body.response_format.json_schema));
  const jitter = 0.95 + rng() * 0.1;
  return Math.max(1, Math.round(n * jitter));
}

// ---- prose ------------------------------------------------------------------------
const OPENERS = [
  'That is a thoughtful question.',
  'Great question, and one with several layers.',
  'There are a few ways to look at this.',
  'It depends, as these things often do.',
  'Let me offer a perspective on that.',
  'This is an area where context matters a great deal.',
  'In broad terms, the answer is nuanced.',
  'Here is a high-level view.',
];
const BODY = [
  'Several factors are worth weighing, and their relative importance can shift over time.',
  'Most outcomes here sit somewhere between the obvious extremes.',
  'It may help to consider the stakeholders involved and what each of them values.',
  'Alignment between the moving parts tends to matter more than any single choice.',
  'Some of the details are still evolving, so a flexible approach is usually wise.',
  'Patterns that worked in one setting do not always carry over cleanly to another.',
  'The data points in more than one direction, which is not unusual.',
  'A measured, iterative approach often reveals more than a single bold move.',
  'Trade-offs are unavoidable; the useful question is which ones are acceptable.',
  'Clarity about the goal usually simplifies the rest of the decision.',
  'There is rarely a single right answer, but there are certainly better and worse ones.',
  'Timing can be as important as the decision itself.',
  'Small, reversible steps reduce risk while the picture becomes clearer.',
  'Experience suggests that the edge cases deserve more attention than they usually get.',
  'Communication between the teams involved will likely shape the result.',
  'Revisiting the assumptions periodically is a sensible safeguard.',
  'The broader context frames how any specific answer should be read.',
  'Reasonable people could interpret the same signals differently.',
  'Balancing short-term needs with long-term direction is part of the challenge.',
  'Documenting the reasoning tends to pay off later.',
];
const CLOSERS = [
  'Ultimately, the best path forward depends on your priorities.',
  'I hope this gives you a useful starting point.',
  'Happy to go deeper on any part of this.',
  'In short: it depends, but thoughtfully so.',
  'Taken together, these considerations should help frame the next step.',
  'Let me know if you would like to explore any of these angles further.',
];

function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return contentText(messages[i].content).text.trim();
  }
  return '';
}

/** Vague prose of roughly `tokens` tokens (about 0.75 words per token), in whole sentences. */
function prose(rng, tokens, prompt) {
  const words = Math.max(1, Math.round(tokens * 0.75));
  const wc = (t) => t.split(/\s+/).filter(Boolean).length;
  const opener = rng.pick(OPENERS);
  if (words <= wc(opener) + 2) return opener.split(/\s+/).slice(0, words).join(' ').replace(/([^.!?])$/, '$1.');
  const parts = [opener];
  let n = wc(opener);
  const closer = rng.pick(CLOSERS);
  const topic = String(prompt || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').replace(/[?.!,;:"]+$/, '').replace(/"/g, "'");
  if (topic && rng() < 0.6) {
    const t = `When it comes to "${topic}", there is more than one reasonable view.`;
    if (n + wc(t) + wc(closer) <= words) { parts.push(t); n += wc(t); }
  }
  for (let guard = 0; guard < 2000; guard += 1) {
    const fits = BODY.filter((x) => n + wc(x) + wc(closer) <= words);
    if (!fits.length) break;
    const next = rng.pick(fits);
    parts.push(next);
    n += wc(next);
  }
  if (n + wc(closer) <= words + 3) parts.push(closer);
  return parts.join(' ');
}

// ---- values from a JSON Schema ----------------------------------------------------
const CITIES = ['Boston', 'Lisbon', 'Osaka', 'Toronto', 'Nairobi', 'Melbourne', 'Denver', 'Oslo'];
const NAMES = ['Alex Morgan', 'Sam Rivera', 'Jordan Lee', 'Taylor Kim', 'Casey Patel', 'Riley Chen'];

function deref(root, s) {
  let cur = s;
  for (let i = 0; i < 20 && cur && typeof cur.$ref === 'string' && cur.$ref.startsWith('#'); i += 1) {
    cur = cur.$ref.slice(1).split('/').slice(1).reduce((o, k) => (o ? o[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), root);
  }
  return cur || {};
}

function stringFor(rng, s, key) {
  if (s.pattern) return fromPattern(s.pattern, s.minLength, s.maxLength);
  const k = String(key || '').toLowerCase();
  let v;
  switch (s.format) {
    case 'date': v = `2026-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`; break;
    case 'date-time': v = new Date(Date.UTC(2026, rng.int(0, 11), rng.int(1, 28), rng.int(0, 23), rng.int(0, 59))).toISOString(); break;
    case 'email': v = `user${rng.int(1, 999)}@example.com`; break;
    case 'uuid': v = `${rng.hex(8)}-${rng.hex(4)}-4${rng.hex(3)}-a${rng.hex(3)}-${rng.hex(12)}`; break;
    case 'uri': case 'url': v = `https://example.com/${rng.id(8)}`; break;
    default:
      if (/city|location|place/.test(k)) v = rng.pick(CITIES);
      else if (/name/.test(k)) v = rng.pick(NAMES);
      else if (/email/.test(k)) v = `user${rng.int(1, 999)}@example.com`;
      else if (/(^|_)id$/i.test(String(key || '')) || /[a-z]Id$/.test(String(key || ''))) v = rng.id(10);
      else if (/unit/.test(k)) v = rng.pick(['celsius', 'fahrenheit']);
      else if (/query|question|search|prompt|text|message|summary|description|reason/.test(k)) v = rng.pick(BODY).replace(/\.$/, '');
      else v = rng.pick(['general', 'standard', 'pending', 'review', 'default', 'balanced']);
  }
  if (s.maxLength && v.length > s.maxLength) v = v.slice(0, s.maxLength);
  return v;
}

function fromSchema(root, schemaIn, rng, key, depth = 0) {
  const s = deref(root, schemaIn || {});
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return rng.pick(s.enum);
  if (s.examples && Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const opts = (s.anyOf || s.oneOf).filter((o) => deref(root, o).type !== 'null');
    return fromSchema(root, opts.length ? rng.pick(opts) : {}, rng, key, depth + 1);
  }
  if (Array.isArray(s.allOf)) return Object.assign({}, ...s.allOf.map((x) => fromSchema(root, x, rng, key, depth + 1)));
  let t = Array.isArray(s.type) ? (s.type.find((x) => x !== 'null') || 'null') : s.type;
  if (!t) t = s.properties ? 'object' : s.items ? 'array' : 'string';
  if (depth > 8) return t === 'array' ? [] : t === 'object' ? {} : null;
  switch (t) {
    case 'null': return null;
    case 'boolean': return rng() < 0.5;
    case 'integer': {
      const min = Math.ceil(s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 0));
      const max = Math.floor(s.maximum ?? (s.exclusiveMaximum !== undefined ? s.exclusiveMaximum - 1 : Math.max(min, 100)));
      return rng.int(min, Math.max(min, max));
    }
    case 'number': {
      const min = s.minimum ?? s.exclusiveMinimum ?? 0;
      const max = s.maximum ?? s.exclusiveMaximum ?? Math.max(min, 100);
      return Math.round((min + rng() * (max - min)) * 100) / 100;
    }
    case 'array': {
      const n = Math.max(s.minItems || 1, Math.min(s.maxItems ?? 3, rng.int(1, 3)));
      return Array.from({ length: n }, () => fromSchema(root, s.items || {}, rng, key, depth + 1));
    }
    case 'object': {
      const out = {};
      const req = new Set(s.required || []);
      for (const [k, ps] of Object.entries(s.properties || {})) {
        if (req.has(k) || rng() < 0.7) out[k] = fromSchema(root, ps, rng, k, depth + 1);
      }
      return out;
    }
    default: return stringFor(rng, s, key);
  }
}

/** A JSON answer for response_format json_object / json_schema. */
function jsonAnswer(rng, responseFormat, prompt) {
  const schema = responseFormat?.json_schema?.schema;
  if (responseFormat?.type === 'json_schema' && schema && typeof schema === 'object') return fromSchema(schema, schema, rng);
  return {
    answer: prose(rng, rng.int(12, 30), prompt),
    confidence: Math.round((0.4 + rng() * 0.55) * 100) / 100,
    considerations: [rng.pick(BODY), rng.pick(BODY)],
  };
}

// ---- embeddings ----------------------------------------------------------------------
/** A unit vector derived from the text (same text, same vector). */
function embedding(text, dims) {
  const out = new Array(dims);
  let block = Buffer.alloc(0);
  let counter = 0;
  let sum = 0;
  for (let i = 0; i < dims; i += 1) {
    if ((i * 2) % 32 === 0) block = crypto.createHash('sha256').update(`${counter++}:${text}`).digest();
    const v = (block.readUInt16LE((i * 2) % 32) / 65535) * 2 - 1;
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum) || 1;
  return out.map((v) => Math.round((v / norm) * 1e8) / 1e8);
}

module.exports = { makeRng, tokensIn, contentText, promptTokens, prose, lastUserText, fromSchema, jsonAnswer, embedding };
