'use strict';
// Build sample requests, send them through the server-side proxy, validate responses, and run whole specs.
const crypto = require('node:crypto');
const { listOperations } = require('./operations');
const { paramSample, mediaSample, mediaExamples, sample, fromPattern } = require('./sample');
const { deref, get, locate, escape } = require('./refs');
const { applyAuth } = require('./auth');

const MAX_BODY_TEXT = 1024 * 1024;

function isJsonType(ct) { return /json/i.test(ct || ''); }
function mediaBase(ct) { return String(ct || '').split(';')[0].trim().toLowerCase(); }

function serverUrl(doc) {
  const s = (doc.servers || [])[0];
  if (!s) return '';
  let url = s.url;
  for (const [k, v] of Object.entries(s.variables || {})) url = url.replace(`{${k}}`, v.default ?? '');
  return url;
}

function pickRequestMedia(content) {
  const keys = Object.keys(content || {});
  return keys.find((k) => /^application\/json/i.test(k)) || keys.find((k) => isJsonType(k))
    || keys.find((k) => /multipart\/form-data/i.test(k)) || keys[0] || null;
}

function isBinarySchema(doc, s) {
  const x = deref(doc, s) || {};
  return x.type === 'string' && (x.format === 'binary' || !!x.contentMediaType) || (x.type === 'array' && isBinarySchema(doc, x.items));
}

// Default request (sample data) for an operation.
function defaultRequest(spec, op, { exampleName, defaultFileId = 'sample-readme-txt' } = {}) {
  const { doc } = spec;
  const params = op.parameters.map((p) => {
    let value;
    if (p.in === 'header' && /^idempotency-key$/i.test(p.name)) value = '{{uuid}}';
    else if (p.in === 'header' && /^x-(correlation|request)-id$/i.test(p.name)) value = '{{uuid}}';
    else value = paramSample(doc, p);
    if (value !== null && typeof value === 'object') value = JSON.stringify(value);
    return {
      in: p.in, name: p.name, required: !!p.required, value: value === undefined || value === null ? '' : String(value),
      enabled: p.in === 'path' || !!p.required || (p.in === 'header' && /^(idempotency-key|x-correlation-id)$/i.test(p.name)),
      description: p.description || '', schema: deref(doc, p.schema) || {},
    };
  });
  const req = { opId: op.id, params, contentType: null, body: null, multipart: null, binary: null, examples: [], exampleName: null };
  const rb = op.requestBody;
  if (rb && rb.content) {
    const media = pickRequestMedia(rb.content);
    const mo = rb.content[media];
    req.contentType = media;
    req.bodyRequired = !!rb.required;
    if (/multipart\/form-data/i.test(media)) {
      const schema = deref(doc, mo.schema) || {};
      req.multipart = Object.entries(schema.properties || {}).map(([name, ps]) => (isBinarySchema(doc, ps)
        ? { name, kind: 'file', fileId: defaultFileId }
        : { name, kind: 'field', value: (() => { const v = sample(doc, ps, { key: name }); return typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''); })() }));
      if (!req.multipart.length) req.multipart = [{ name: 'file', kind: 'file', fileId: defaultFileId }];
    } else if (/octet-stream|^image\/|^application\/pdf|^\*\/\*/i.test(media) || isBinarySchema(doc, mo.schema)) {
      req.binary = { fileId: defaultFileId };
    } else {
      req.examples = mediaExamples(doc, mo).map((e) => ({ name: e.name, summary: e.summary, value: e.value }));
      const chosen = exampleName && req.examples.find((e) => e.name === exampleName);
      if (chosen) { req.body = JSON.parse(JSON.stringify(chosen.value)); req.exampleName = chosen.name; } else {
        const s = mediaSample(doc, mo, 'request');
        req.body = s.value;
        req.exampleName = s.source;
      }
      if (!isJsonType(media) && typeof req.body !== 'string') req.body = typeof req.body === 'object' ? JSON.stringify(req.body) : String(req.body ?? '');
    }
  }
  return req;
}

function renderTemplate(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, key) => {
    if (key === 'uuid' || key === '$guid') return crypto.randomUUID();
    if (key === 'now') return new Date().toISOString();
    if (key === 'timestamp') return String(Math.floor(Date.now() / 1000));
    const k = key.startsWith('var.') ? key.slice(4) : key;
    return vars && vars[k] !== undefined ? String(vars[k]) : m;
  });
}

function deepRender(v, vars) {
  if (typeof v === 'string') return renderTemplate(v, vars);
  if (Array.isArray(v)) return v.map((x) => deepRender(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRender(x, vars)]));
  return v;
}

async function fileBlob(ctx, ref) {
  if (ref.upload && ref.upload.base64) {
    return { buffer: Buffer.from(ref.upload.base64, 'base64'), name: ref.upload.filename || 'upload.bin', type: ref.upload.contentType || 'application/octet-stream' };
  }
  const f = await ctx.files.mustGet(ref.fileId);
  return { buffer: await ctx.files.readBuffer(f), name: f.name, type: f.contentType };
}

// Execute one request. target = { baseUrl, auth, headers, timeoutMs }.
async function execute(ctx, spec, op, request, target = {}, { vars = {}, noAuth = false } = {}) {
  const base = String(target.baseUrl || serverUrl(spec.doc) || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    return { error: `No usable base URL ("${base || 'none'}"). Set a base URL override for this spec.`, checks: [], pass: false };
  }
  let path = op.path;
  const query = {};
  const headers = {};
  for (const [k, v] of Object.entries(target.headers || {})) headers[k] = renderTemplate(String(v), vars);
  for (const p of request.params || []) {
    if (!p.enabled && p.in !== 'path') continue;
    const val = renderTemplate(String(p.value ?? ''), vars);
    if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(val));
    else if (p.in === 'query') query[p.name] = val;
    else if (p.in === 'header') headers[p.name] = val;
    else if (p.in === 'cookie') headers.Cookie = [headers.Cookie, `${p.name}=${encodeURIComponent(val)}`].filter(Boolean).join('; ');
  }
  let tokenExchange = null;
  const authReq = { headers, query };
  const secured = Array.isArray(op.security) ? op.security.length > 0 && !op.security.every((s) => Object.keys(s).length === 0) : true;
  if (!noAuth && secured && target.auth) {
    try {
      tokenExchange = await applyAuth(target.auth, authReq);
    } catch (e) {
      return { error: e.message, tokenExchange: e.exchange || null, checks: [{ name: 'auth', status: 'fail', message: e.message }], pass: false };
    }
  }

  let body;
  let bodyPreview = null;
  if (request.multipart) {
    const fd = new FormData();
    for (const part of request.multipart) {
      if (part.enabled === false) continue;
      if (part.kind === 'file') {
        const f = await fileBlob(ctx, part);
        fd.append(part.name, new Blob([f.buffer], { type: f.type }), f.name);
      } else fd.append(part.name, renderTemplate(String(part.value ?? ''), vars));
    }
    body = fd;
    bodyPreview = request.multipart.map((p) => (p.kind === 'file' ? `[file ${p.name}: ${p.fileId || p.upload?.filename}]` : `${p.name}=${p.value}`)).join('\n');
  } else if (request.binary) {
    const f = await fileBlob(ctx, request.binary);
    body = f.buffer;
    headers['Content-Type'] = headers['Content-Type'] || request.contentType || f.type;
    bodyPreview = `[binary ${f.name}, ${f.buffer.length} bytes]`;
  } else if (request.body !== null && request.body !== undefined && request.contentType) {
    const rendered = deepRender(request.body, vars);
    body = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
    headers['Content-Type'] = headers['Content-Type'] || request.contentType;
    bodyPreview = body.length > 20000 ? `${body.slice(0, 20000)}…` : body;
  }
  if (!headers.Accept && !headers.accept) headers.Accept = 'application/json, application/problem+json;q=0.9, */*;q=0.5';

  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const started = process.hrtime.bigint();
  const reqInfo = { method: op.method.toUpperCase(), url: url.toString(), headers: { ...headers }, body: bodyPreview };
  let res;
  try {
    res = await fetch(url, { method: op.method.toUpperCase(), headers, body, redirect: 'manual', signal: AbortSignal.timeout(target.timeoutMs || 30000) });
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? `Timed out after ${target.timeoutMs || 30000} ms` : (e.cause?.message || e.message);
    return { request: reqInfo, error: msg, tokenExchange, checks: [{ name: 'transport', status: 'fail', message: msg }], pass: false };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const resHeaders = Object.fromEntries(res.headers.entries());
  const ct = resHeaders['content-type'] || '';
  const textual = !ct || /json|text|xml|yaml|javascript|html|x-www-form-urlencoded/i.test(ct);
  let json;
  let jsonError = null;
  if (buf.length && (isJsonType(ct) || (!ct && /^[\s]*[{[]/.test(buf.toString('utf8', 0, 64))))) {
    try { json = JSON.parse(buf.toString('utf8')); } catch (e) { jsonError = e.message; }
  }
  const response = {
    status: res.status, statusText: res.statusText, headers: resHeaders, size: buf.length, durationMs: Math.round(durationMs * 10) / 10,
    body: textual ? buf.toString('utf8', 0, Math.min(buf.length, MAX_BODY_TEXT)) : null,
    bodyBase64: !textual ? buf.subarray(0, 64 * 1024).toString('base64') : null,
    truncated: buf.length > MAX_BODY_TEXT,
    json, jsonError,
  };
  return { request: reqInfo, response, tokenExchange };
}

function matchStatus(responses, status) {
  const s = String(status);
  if (responses[s]) return s;
  const range = `${s[0]}XX`;
  if (responses[range]) return range;
  const rangeLower = `${s[0]}xx`;
  if (responses[rangeLower]) return rangeLower;
  if (responses.default) return 'default';
  return null;
}

function mediaMatch(declared, actual) {
  const a = mediaBase(actual);
  if (!a) return null;
  for (const d of declared) {
    const db = mediaBase(d);
    if (db === a || db === '*/*') return d;
    const [dt, ds] = db.split('/');
    const [at, as] = a.split('/');
    if (dt === at && ds === '*') return d;
    if (ds === 'json' && as && as.endsWith('+json') && dt === at) return d;
  }
  return null;
}

// Validate a response against the operation. Returns checks[].
function validateResponse(spec, validator, op, response) {
  const checks = [];
  const { doc } = spec;
  const code = matchStatus(op.responses, response.status);
  if (!code) {
    checks.push({ name: 'status-documented', status: 'fail', message: `Status ${response.status} is not documented (documented: ${Object.keys(op.responses).join(', ')})` });
    return checks;
  }
  checks.push({ name: 'status-documented', status: 'pass', message: `Status ${response.status} documented as "${code}"` });
  const respPointer = locate(doc, op.pointer, ['responses', code]);
  const resp = respPointer ? get(doc, respPointer) : null;
  if (!resp) return checks;

  // headers
  for (const [hName, hRef] of Object.entries(resp.headers || {})) {
    if (hName.toLowerCase() === 'content-type') continue;
    const h = deref(doc, hRef) || {};
    const present = response.headers[hName.toLowerCase()] !== undefined;
    const important = h.required === true || /^(location|etag)$/i.test(hName);
    if (present) checks.push({ name: `header:${hName}`, status: 'pass', message: `${hName} present` });
    else checks.push({ name: `header:${hName}`, status: important ? 'fail' : 'warn', message: `Declared response header ${hName} is missing${important ? '' : ' (optional)'}` });
    if (present && h.schema) {
      const hs = deref(doc, h.schema) || {};
      const v = response.headers[hName.toLowerCase()];
      const val = hs.type === 'integer' || hs.type === 'number' ? Number(v) : v;
      const hp = locate(doc, respPointer, ['headers', hName, 'schema']);
      if (hp) {
        const errs = validator.validate(hp, val);
        if (errs.length) checks.push({ name: `header-schema:${hName}`, status: 'warn', message: `${hName} value does not match its schema: ${errs[0].message}` });
      }
    }
  }

  // content type + body
  const declared = Object.keys(resp.content || {});
  const ct = response.headers['content-type'];
  const hasBody = response.size > 0;
  if (!declared.length) {
    if (hasBody) checks.push({ name: 'content-type', status: 'warn', message: `No response body is documented, but ${response.size} bytes were returned` });
    return checks;
  }
  if (!hasBody) {
    checks.push({ name: 'body', status: response.status === 204 || response.status === 304 ? 'pass' : 'fail', message: 'Response body is empty but content is documented' });
    return checks;
  }
  const media = mediaMatch(declared, ct);
  if (!media) {
    checks.push({ name: 'content-type', status: 'fail', message: `Content-Type "${ct || 'missing'}" does not match documented ${declared.join(', ')}` });
    return checks;
  }
  checks.push({ name: 'content-type', status: 'pass', message: `Content-Type ${mediaBase(ct)} matches ${media}` });
  const mo = resp.content[media];
  if (!mo?.schema) return checks;
  if (isJsonType(media) || isJsonType(ct)) {
    if (response.jsonError) {
      checks.push({ name: 'body-json', status: 'fail', message: `Body is not valid JSON: ${response.jsonError}` });
      return checks;
    }
    const schemaPointer = `${respPointer}/content/${escape(media)}/schema`;
    const errs = validator.validate(schemaPointer, response.json);
    if (errs.length) checks.push({ name: 'body-schema', status: 'fail', message: `${errs.length} schema violation${errs.length > 1 ? 's' : ''}`, errors: errs.slice(0, 50), schemaPointer });
    else checks.push({ name: 'body-schema', status: 'pass', message: 'Body matches the schema', schemaPointer });
  }
  return checks;
}

function summarize(checks) {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}

// ---------- run all ----------

function singular(seg) {
  if (/ies$/.test(seg)) return seg.replace(/ies$/, 'y');
  if (/ses$/.test(seg)) return seg.replace(/es$/, '');
  return seg.replace(/s$/, '');
}
function camel(s) { return s.replace(/[-_]+([a-z0-9])/gi, (_m, c) => c.toUpperCase()); }

function templateRegex(path) {
  const names = [];
  const src = path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{([^}]+)\\?\}/g, (_m, n) => { names.push(n); return '([^/]+)'; });
  return { re: new RegExp(`${src}/?$`), names };
}

function captureVars(ops, op, result, vars, { override }) {
  const set = (k, v) => {
    if (v === undefined || v === null || typeof v === 'object' || v === '') return;
    if (override || vars[k] === undefined) vars[k] = String(v);
  };
  const loc = result.response?.headers?.location;
  if (loc) {
    let pathname = loc;
    try { pathname = new URL(loc, 'http://x').pathname; } catch { /* keep */ }
    for (const o of ops) {
      const { re, names } = templateRegex(o.path);
      if (!names.length) continue;
      const m = re.exec(pathname);
      if (m) names.forEach((n, i) => set(n, decodeURIComponent(m[i + 1])));
    }
  }
  const json = result.response?.json;
  const lastStatic = op.path.split('/').filter((s) => s && !s.startsWith('{')).pop() || '';
  const nounId = `${camel(singular(lastStatic))}Id`;
  const walk = (v, depth, top) => {
    if (!v || typeof v !== 'object' || depth > 3) return;
    if (Array.isArray(v)) { if (v.length) walk(v[0], depth + 1, false); return; }
    for (const [k, x] of Object.entries(v)) {
      if (x !== null && typeof x === 'object') { walk(x, depth + 1, false); continue; }
      if (/Id$/.test(k) || k === 'id') {
        if (k === 'id') {
          if (top) { set('id', x); set(nounId, x); }
        } else set(k, x);
      }
    }
  };
  if (json) {
    walk(json, 0, !Array.isArray(json));
    // Collections: take ids from the first item of the main array.
    const arr = Array.isArray(json) ? json : Object.values(json).find((x) => Array.isArray(x) && x.length && typeof x[0] === 'object');
    if (arr && arr[0]) {
      const item = arr[0];
      if (item.id !== undefined) { set(nounId, item.id); set('id', item.id); }
      for (const [k, x] of Object.entries(item)) if (/Id$/.test(k)) set(k, x);
    }
  }
}

function phaseOf(op) {
  const hasPathParam = op.path.includes('{');
  if (op.method === 'delete') return 3;
  if (op.method === 'post' && !hasPathParam) return 0;
  if (op.method === 'get' && !hasPathParam) return 1;
  return 2;
}

function unknownValue(doc, param) {
  const s = deref(doc, param.schema) || {};
  if (s.type === 'integer' || s.type === 'number') return String(Math.min(s.maximum ?? 2147483646, 999999937));
  if (s.format === 'uuid') return '00000000-0000-4000-8000-00000000dead';
  if (s.pattern) {
    for (let i = 0; i < 10; i++) {
      const v = fromPattern(s.pattern, s.minLength, s.maxLength).replace(/[0-9]/g, '9');
      if (new RegExp(s.pattern).test(v)) return v;
    }
    return fromPattern(s.pattern, s.minLength, s.maxLength);
  }
  return `does-not-exist-${crypto.randomBytes(3).toString('hex')}`;
}

async function runAll(ctx, spec, validator, opts = {}) {
  const { target = {}, negative = false, variables = {}, operationIds } = opts;
  const all = listOperations(spec.doc);
  const ops = all.filter((o) => !operationIds || !operationIds.length || operationIds.includes(o.id))
    .filter((o) => !['options', 'head', 'trace'].includes(o.method))
    .sort((a, b) => phaseOf(a) - phaseOf(b));
  const vars = {};
  const steps = [];
  const manual = { ...(variables || {}) };
  const authOn = target.auth && target.auth.type && target.auth.type !== 'none';

  for (const op of ops) {
    const req = defaultRequest(spec, op);
    for (const p of req.params) {
      const v = manual[p.name] ?? vars[p.name];
      if (v !== undefined && (p.in === 'path' || p.enabled)) p.value = String(v);
    }
    const r = await execute(ctx, spec, op, req, target, { vars: { ...vars, ...manual } });
    const checks = r.error ? r.checks : validateResponse(spec, validator, op, r.response);
    if (!r.error && r.response.status >= 400) checks.push({ name: 'success-status', status: 'fail', message: `Expected a 2xx response for the positive test, got ${r.response.status}` });
    const outcome = summarize(checks);
    steps.push({ kind: 'positive', opId: op.id, operationId: op.operationId, phase: phaseOf(op), ...r, checks, outcome, pass: outcome !== 'fail' });
    if (!r.error && r.response.status < 400) captureVars(all, op, r, vars, { override: phaseOf(op) === 0 });

    if (!negative) continue;
    const secured = Array.isArray(op.security) && op.security.some((s) => Object.keys(s).length);
    if (secured && authOn) {
      const nr = await execute(ctx, spec, op, req, target, { vars: { ...vars, ...manual }, noAuth: true });
      const nchecks = nr.error ? nr.checks : [];
      if (!nr.error) {
        const st = nr.response.status;
        nchecks.push({ name: 'expect-401', status: st === 401 ? 'pass' : st === 403 ? 'warn' : 'fail', message: st === 401 ? 'Unauthenticated request rejected with 401' : `Expected 401 without credentials, got ${st}` });
        if (st >= 400) nchecks.push(...validateResponse(spec, validator, op, nr.response).filter((c) => c.name !== 'status-documented' || c.status === 'fail'));
      }
      const o = summarize(nchecks);
      steps.push({ kind: 'negative', test: 'no-auth', opId: op.id, operationId: op.operationId, ...nr, checks: nchecks, outcome: o, pass: o !== 'fail' });
    }
    const json = op.requestBody && req.body && typeof req.body === 'object' && !Array.isArray(req.body) && req.contentType && isJsonType(req.contentType);
    if (json) {
      const media = op.requestBody.content[req.contentType];
      const schema = deref(spec.doc, media?.schema) || {};
      const requiredProps = schema.required || (schema.allOf ? schema.allOf.flatMap((x) => deref(spec.doc, x)?.required || []) : []);
      if (requiredProps.length) {
        const bad = { ...req, body: { ...req.body } };
        delete bad.body[requiredProps[0]];
        const nr = await execute(ctx, spec, op, bad, target, { vars: { ...vars, ...manual } });
        const nchecks = nr.error ? nr.checks : [];
        if (!nr.error) {
          const st = nr.response.status;
          nchecks.push({ name: 'expect-400-or-422', status: st === 400 || st === 422 ? 'pass' : 'fail', message: st === 400 || st === 422 ? `Missing "${requiredProps[0]}" rejected with ${st}` : `Expected 400 or 422 when "${requiredProps[0]}" is missing, got ${st}` });
          if (st >= 400) nchecks.push(...validateResponse(spec, validator, op, nr.response));
        }
        const o = summarize(nchecks);
        steps.push({ kind: 'negative', test: 'invalid-body', opId: op.id, operationId: op.operationId, removed: requiredProps[0], ...nr, checks: nchecks, outcome: o, pass: o !== 'fail' });
      }
    }
    const pathParams = req.params.filter((p) => p.in === 'path');
    if (op.method === 'get' && pathParams.length) {
      const bad = { ...req, params: req.params.map((p) => ({ ...p })) };
      const last = bad.params.filter((p) => p.in === 'path').pop();
      const def = op.parameters.find((p) => p.in === 'path' && p.name === last.name);
      last.value = unknownValue(spec.doc, def);
      const nr = await execute(ctx, spec, op, bad, target, { vars: { ...vars, ...manual } });
      const nchecks = nr.error ? nr.checks : [];
      if (!nr.error) {
        const st = nr.response.status;
        nchecks.push({ name: 'expect-404', status: st === 404 ? 'pass' : 'fail', message: st === 404 ? `Unknown ${last.name} returned 404` : `Expected 404 for unknown ${last.name}=${last.value}, got ${st}` });
        if (st >= 400) nchecks.push(...validateResponse(spec, validator, op, nr.response));
      }
      const o = summarize(nchecks);
      steps.push({ kind: 'negative', test: 'unknown-id', opId: op.id, operationId: op.operationId, ...nr, checks: nchecks, outcome: o, pass: o !== 'fail' });
    }
  }
  const summary = {
    total: steps.length,
    passed: steps.filter((s) => s.outcome === 'pass').length,
    warned: steps.filter((s) => s.outcome === 'warn').length,
    failed: steps.filter((s) => s.outcome === 'fail').length,
  };
  return { steps, summary, variables: { ...vars, ...manual } };
}

module.exports = { defaultRequest, execute, validateResponse, runAll, summarize, serverUrl, captureVars, templateRegex, matchStatus };
