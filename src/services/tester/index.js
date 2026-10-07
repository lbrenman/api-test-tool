'use strict';
// Tester service (the shared core): persisted contracts ("specs") and runs, lint cache, target and
// auth handling, run history. Everything that depends on the contract language lives in an adapter:
//   adapters/openapi.js  OpenAPI 3.0 / 3.1 and Swagger 2.0 (REST)
//   adapters/wsdl/       WSDL 1.1 (SOAP 1.1 / 1.2)
// A spec's adapter is chosen by spec.kind (older records without a kind are OpenAPI).
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { mask } = require('./auth');
const { HttpError } = require('../../util/problem');
const { OpenApiAdapter } = require('./adapters/openapi');
const { WsdlAdapter } = require('./adapters/wsdl');

const SAMPLES_DIR = path.resolve(__dirname, '../../../samples');
const MAX_STEP_BODY = 64 * 1024;
const SAMPLE_FILES = /\.(ya?ml|json|wsdl)$/i;

function maskAuth(auth) {
  if (!auth) return auth;
  const out = { ...auth };
  for (const k of ['value', 'password', 'token', 'clientSecret']) if (out[k]) out[k] = mask(out[k]);
  return out;
}

function trimStep(step) {
  const s = { ...step };
  if (s.response) {
    s.response = { ...s.response };
    delete s.response.json;
    if (s.response.body && s.response.body.length > MAX_STEP_BODY) { s.response.body = s.response.body.slice(0, MAX_STEP_BODY); s.response.truncated = true; }
    if (s.response.bodyBase64 && s.response.bodyBase64.length > MAX_STEP_BODY) s.response.bodyBase64 = s.response.bodyBase64.slice(0, MAX_STEP_BODY);
  }
  return s;
}

async function fetchContract(url) {
  let u;
  try { u = new URL(url); } catch { throw new HttpError(422, 'Invalid spec URL', { code: 'spec-load-failed' }); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(422, 'Spec URL must be http(s)', { code: 'spec-load-failed' });
  let res;
  try {
    res = await fetch(u, { headers: { Accept: 'application/yaml, application/json;q=0.9, text/xml;q=0.9, application/wsdl+xml;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new HttpError(422, `Fetching spec failed: ${e.cause?.message || e.message}`, { code: 'spec-load-failed' });
  }
  if (!res.ok) throw new HttpError(422, `Fetching spec failed: HTTP ${res.status}`, { code: 'spec-load-failed' });
  return res.text();
}

class TesterService {
  constructor(ctx) {
    this.ctx = ctx;
    this.adapters = { openapi: new OpenApiAdapter(ctx), wsdl: new WsdlAdapter(ctx) };
    this.lints = new Map();
  }

  adapter(spec) {
    const a = this.adapters[spec?.kind || 'openapi'];
    if (!a) throw new HttpError(500, `No tester adapter for contract kind "${spec.kind}"`);
    return a;
  }

  detect(text, url) {
    if (url && /([?&]wsdl\b|\.wsdl$)/i.test(url)) return 'wsdl';
    return this.adapters.wsdl.detect(text) ? 'wsdl' : 'openapi';
  }

  async samples() {
    const files = (await fs.readdir(SAMPLES_DIR).catch(() => [])).filter((f) => SAMPLE_FILES.test(f))
      .sort((a, b) => Number(/\.wsdl$/i.test(a)) - Number(/\.wsdl$/i.test(b)) || Number(/swagger_?2/i.test(a)) - Number(/swagger_?2/i.test(b)) || a.localeCompare(b));
    return [
      ...files.map((f) => ({ id: f, name: f.replace(/[_-]/g, ' ').replace(SAMPLE_FILES, ''), file: f, url: `/samples/${f}`, kind: /\.wsdl$/i.test(f) ? 'wsdl' : 'openapi' })),
      { id: 'self', name: 'This tool (live /openapi.json)', url: '/openapi.json', kind: 'openapi' },
      { id: 'self-soap', name: 'This tool (live SOAP WSDL: EmployeeService)', url: '/soap/EmployeeService?wsdl', kind: 'wsdl' },
    ];
  }

  async sampleContent(sample, req) {
    if (sample === 'self') {
      const { generateOpenApi } = require('../openapiGen');
      return { text: JSON.stringify(await generateOpenApi(this.ctx, req)), kind: 'openapi', target: { baseUrl: this.ctx.baseUrl(req) } };
    }
    if (sample === 'self-soap') {
      const { SERVICES } = require('../../protocols/soap/services');
      const { generateWsdl } = require('../../protocols/soap/wsdl');
      const endpoint = `${this.ctx.baseUrl(req)}/soap/EmployeeService`;
      return { text: generateWsdl(SERVICES.EmployeeService, endpoint), kind: 'wsdl', target: { baseUrl: endpoint } };
    }
    const file = path.join(SAMPLES_DIR, path.basename(sample));
    const text = await fs.readFile(file, 'utf8').catch(() => { throw new HttpError(404, `Unknown sample ${sample}`); });
    return { text, kind: this.detect(text, file) };
  }

  async create({ name, content, url, sample, source }, req) {
    let src = source || (url ? { type: 'url', url } : { type: 'paste' });
    let text = content;
    let kind;
    let targetOverride = null;
    if (sample) {
      const s = await this.sampleContent(sample, req);
      ({ text, kind } = s);
      targetOverride = s.target || null;
      src = { type: 'sample', sample: sample === 'self' || sample === 'self-soap' ? sample : path.basename(sample) };
    } else if (!text && url) {
      text = await fetchContract(url);
    }
    kind = kind || this.detect(text, url);
    let loaded;
    try {
      loaded = await this.adapters[kind].load({ content: text, url: src.type === 'url' ? url : undefined });
    } catch (e) {
      throw new HttpError(e.status || 422, e.message, { code: 'spec-load-failed' });
    }
    const now = new Date().toISOString();
    const id = `spec_${crypto.randomBytes(6).toString('hex')}`;
    const spec = {
      id,
      kind,
      name: name || loaded.title,
      title: loaded.title,
      apiVersion: loaded.apiVersion,
      version: loaded.version,
      originalVersion: loaded.originalVersion,
      converted: loaded.converted,
      notes: loaded.notes,
      structural: loaded.structural,
      source: src,
      doc: loaded.doc,
      ...(loaded.raw !== undefined ? { raw: loaded.raw } : {}),
      target: {
        auth: { type: 'none' },
        headers: {},
        timeoutMs: 30000,
        ...loaded.defaultTarget,
        ...(targetOverride || {}),
      },
      options: loaded.options || {},
      createdAt: now,
      updatedAt: now,
    };
    await this.ctx.repo.put('tester_specs', id, spec);
    return spec;
  }

  async list() {
    return (await this.ctx.repo.list('tester_specs')).map((s) => ({
      id: s.id, kind: s.kind || 'openapi', name: s.name, title: s.title, apiVersion: s.apiVersion, version: s.version, originalVersion: s.originalVersion,
      converted: s.converted, source: s.source, operations: this.adapter(s).operationCount(s), baseUrl: s.target?.baseUrl, updatedAt: s.updatedAt,
      lastRun: s.lastRun || null,
    })).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(id) {
    const s = await this.ctx.repo.get('tester_specs', id);
    if (!s) throw new HttpError(404, `Spec ${id} not found`);
    if (!s.kind) s.kind = 'openapi';
    return s;
  }

  async update(id, patch) {
    const s = await this.get(id);
    if (patch.name !== undefined) s.name = String(patch.name).slice(0, 200) || s.name;
    if (patch.target) s.target = { ...s.target, ...patch.target };
    if (patch.options) s.options = { ...s.options, ...patch.options };
    if (patch.content) {
      const loaded = await this.adapter(s).load({ content: patch.content, url: patch.url }).catch((e) => { throw new HttpError(422, e.message); });
      Object.assign(s, { doc: loaded.doc, version: loaded.version, originalVersion: loaded.originalVersion, converted: loaded.converted, notes: loaded.notes, structural: loaded.structural, title: loaded.title, apiVersion: loaded.apiVersion });
      if (loaded.raw !== undefined) s.raw = loaded.raw;
    }
    s.updatedAt = new Date().toISOString();
    await this.ctx.repo.put('tester_specs', id, s);
    this.invalidate(id);
    return s;
  }

  async reload(id, req) {
    const s = await this.get(id);
    if (s.source?.type === 'sample') {
      const { text } = await this.sampleContent(s.source.sample, req);
      return this.update(id, { content: text });
    }
    if (s.source?.type !== 'url') throw new HttpError(400, 'Only URL or bundled-sample specs can be reloaded; paste the new content instead');
    if (s.kind === 'openapi') {
      // Keep the original behaviour: the loader fetches the URL itself so relative external $refs resolve.
      const loaded = await this.adapters.openapi.load({ url: s.source.url }).catch((e) => { throw new HttpError(422, e.message); });
      return this.update(id, { content: JSON.stringify(loaded.doc) });
    }
    return this.update(id, { content: await fetchContract(s.source.url), url: s.source.url });
  }

  async remove(id) {
    await this.get(id);
    await this.ctx.repo.del('tester_specs', id);
    for (const r of await this.ctx.repo.list('tester_runs')) if (r.specId === id) await this.ctx.repo.del('tester_runs', r.id);
    this.invalidate(id);
  }

  invalidate(id) {
    for (const a of Object.values(this.adapters)) a.invalidate(id);
    this.lints.delete(id);
  }

  lint(spec) {
    const cached = this.lints.get(spec.id);
    if (cached && cached.updatedAt === spec.updatedAt) return cached.result;
    const result = this.adapter(spec).lint(spec);
    this.lints.set(spec.id, { updatedAt: spec.updatedAt, result });
    return result;
  }

  operations(spec) { return this.adapter(spec).operations(spec); }

  defaultRequest(spec, opId, exampleName, opts = {}) { return this.adapter(spec).defaultRequest(spec, opId, exampleName, opts); }

  async send(spec, { opId, request, target, lenientAllOf }) {
    const t = { ...spec.target, ...(target || {}) };
    return this.adapter(spec).send(spec, { opId, request, target: t, lenientAllOf });
  }

  async run(spec, { negative = false, variables = {}, operationIds, target, lenientAllOf } = {}) {
    const startedAt = new Date();
    const t = { ...spec.target, ...(target || {}) };
    const result = await this.adapter(spec).run(spec, { target: t, negative, variables, operationIds, lenientAllOf });
    const run = {
      id: `run_${crypto.randomBytes(6).toString('hex')}`,
      specId: spec.id,
      specName: spec.name,
      kind: spec.kind,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      target: { ...t, auth: maskAuth(t.auth) },
      options: { negative, lenientAllOf: !!result.options?.lenientAllOf, operationIds: operationIds || null },
      summary: result.summary,
      variables: result.variables,
      steps: result.steps.map(trimStep),
    };
    await this.ctx.repo.put('tester_runs', run.id, run);
    spec.lastRun = { id: run.id, at: run.finishedAt, summary: run.summary };
    await this.ctx.repo.put('tester_specs', spec.id, spec);
    // keep the 50 most recent runs per spec
    const runs = (await this.ctx.repo.list('tester_runs')).filter((r) => r.specId === spec.id).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    for (const old of runs.slice(50)) await this.ctx.repo.del('tester_runs', old.id);
    return run;
  }

  async runs(specId) {
    return (await this.ctx.repo.list('tester_runs')).filter((r) => !specId || r.specId === specId)
      .map((r) => ({ id: r.id, specId: r.specId, specName: r.specName, startedAt: r.startedAt, durationMs: r.durationMs, summary: r.summary, options: r.options, baseUrl: r.target?.baseUrl }))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async getRun(id) {
    const r = await this.ctx.repo.get('tester_runs', id);
    if (!r) throw new HttpError(404, `Run ${id} not found`);
    return r;
  }

  async deleteRun(id) { await this.ctx.repo.del('tester_runs', id); }

  profiles(spec) { return this.adapter(spec).profiles(spec); }

  async mock(spec, req) { return this.adapter(spec).mock(spec, req); }

  async unmock(spec) { return this.adapter(spec).unmock(spec); }

  document(spec) { return this.adapter(spec).document(spec); }
}

module.exports = { TesterService };
