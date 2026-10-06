'use strict';
// Tester service: persisted specs + runs, validator cache, glue around load/lint/sample/run/mock.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadSpec } = require('./load');
const { lintSpec } = require('./lint');
const { SpecValidator } = require('./validate');
const { listOperations } = require('./operations');
const { defaultRequest, execute, validateResponse, runAll, summarize, serverUrl } = require('./runner');
const { profilesFromSpec, mask } = require('./auth');
const { installMock, removeMock, slugify } = require('./mock');
const { HttpError } = require('../../util/problem');

const SAMPLES_DIR = path.resolve(__dirname, '../../../samples');
const MAX_STEP_BODY = 64 * 1024;

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

class TesterService {
  constructor(ctx) {
    this.ctx = ctx;
    this.validators = new Map();
    this.lints = new Map();
  }

  async samples() {
    const files = (await fs.readdir(SAMPLES_DIR).catch(() => [])).filter((f) => /\.(ya?ml|json)$/i.test(f));
    return [
      ...files.map((f) => ({ id: f, name: f.replace(/[_-]/g, ' ').replace(/\.(ya?ml|json)$/i, ''), file: f, url: `/samples/${f}` })),
      { id: 'self', name: 'This tool (live /openapi.json)', url: '/openapi.json' },
    ];
  }

  async create({ name, content, url, sample, source }, req) {
    let src = source || (url ? { type: 'url', url } : { type: 'paste' });
    let text = content;
    if (sample) {
      if (sample === 'self') {
        const { generateOpenApi } = require('../openapiGen');
        text = JSON.stringify(await generateOpenApi(this.ctx, req));
        src = { type: 'sample', sample: 'self' };
      } else {
        const file = path.join(SAMPLES_DIR, path.basename(sample));
        text = await fs.readFile(file, 'utf8').catch(() => { throw new HttpError(404, `Unknown sample ${sample}`); });
        src = { type: 'sample', sample: path.basename(sample) };
      }
    }
    let loaded;
    try {
      loaded = await loadSpec({ content: text, url: text ? undefined : url });
    } catch (e) {
      throw new HttpError(e.status || 422, e.message, { code: 'spec-load-failed' });
    }
    const now = new Date().toISOString();
    const id = `spec_${crypto.randomBytes(6).toString('hex')}`;
    const isSelf = src.sample === 'self';
    const spec = {
      id,
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
      target: {
        baseUrl: isSelf ? this.ctx.baseUrl(req) : serverUrl(loaded.doc),
        auth: { type: 'none' },
        headers: {},
        timeoutMs: 30000,
      },
      options: { lenientAllOf: false },
      createdAt: now,
      updatedAt: now,
    };
    await this.ctx.repo.put('tester_specs', id, spec);
    return spec;
  }

  async list() {
    return (await this.ctx.repo.list('tester_specs')).map((s) => ({
      id: s.id, name: s.name, title: s.title, apiVersion: s.apiVersion, version: s.version, originalVersion: s.originalVersion,
      converted: s.converted, source: s.source, operations: listOperations(s.doc).length, baseUrl: s.target?.baseUrl, updatedAt: s.updatedAt,
      lastRun: s.lastRun || null,
    })).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(id) {
    const s = await this.ctx.repo.get('tester_specs', id);
    if (!s) throw new HttpError(404, `Spec ${id} not found`);
    return s;
  }

  async update(id, patch) {
    const s = await this.get(id);
    if (patch.name !== undefined) s.name = String(patch.name).slice(0, 200) || s.name;
    if (patch.target) s.target = { ...s.target, ...patch.target };
    if (patch.options) s.options = { ...s.options, ...patch.options };
    if (patch.content) {
      const loaded = await loadSpec({ content: patch.content }).catch((e) => { throw new HttpError(422, e.message); });
      Object.assign(s, { doc: loaded.doc, version: loaded.version, originalVersion: loaded.originalVersion, converted: loaded.converted, notes: loaded.notes, structural: loaded.structural, title: loaded.title, apiVersion: loaded.apiVersion });
    }
    s.updatedAt = new Date().toISOString();
    await this.ctx.repo.put('tester_specs', id, s);
    this.invalidate(id);
    return s;
  }

  async reload(id, req) {
    const s = await this.get(id);
    let text;
    if (s.source?.type === 'url') text = undefined;
    else if (s.source?.type === 'sample') {
      const fresh = await this.create({ sample: s.source.sample }, req);
      await this.ctx.repo.del('tester_specs', fresh.id);
      return this.update(id, { content: JSON.stringify(fresh.doc) });
    } else throw new HttpError(400, 'Only URL or bundled-sample specs can be reloaded; paste the new content instead');
    const loaded = await loadSpec({ url: s.source.url, content: text }).catch((e) => { throw new HttpError(422, e.message); });
    return this.update(id, { content: JSON.stringify(loaded.doc) });
  }

  async remove(id) {
    await this.get(id);
    await this.ctx.repo.del('tester_specs', id);
    for (const r of await this.ctx.repo.list('tester_runs')) if (r.specId === id) await this.ctx.repo.del('tester_runs', r.id);
    this.invalidate(id);
  }

  invalidate(id) {
    for (const k of [...this.validators.keys()]) if (k.startsWith(`${id}|`)) this.validators.delete(k);
    this.lints.delete(id);
  }

  validator(spec, lenient = spec.options?.lenientAllOf) {
    const key = `${spec.id}|${spec.updatedAt}|${!!lenient}`;
    if (!this.validators.has(key)) this.validators.set(key, new SpecValidator(spec.doc, { version: spec.version, lenientAllOf: !!lenient }));
    return this.validators.get(key);
  }

  lint(spec) {
    const key = spec.id;
    const cached = this.lints.get(key);
    if (cached && cached.updatedAt === spec.updatedAt) return cached.result;
    const result = lintSpec(spec);
    this.lints.set(key, { updatedAt: spec.updatedAt, result });
    return result;
  }

  operations(spec) {
    return listOperations(spec.doc).map((o) => ({
      id: o.id, method: o.method, path: o.path, operationId: o.operationId, summary: o.summary, tags: o.tags, deprecated: o.deprecated,
      hasBody: !!o.requestBody, secured: Array.isArray(o.security) && o.security.some((x) => Object.keys(x).length),
      responses: Object.keys(o.responses || {}),
    }));
  }

  op(spec, opId) {
    const op = listOperations(spec.doc).find((o) => o.id === opId || o.operationId === opId);
    if (!op) throw new HttpError(404, `Operation ${opId} not found in spec`);
    return op;
  }

  defaultRequest(spec, opId, exampleName) {
    return defaultRequest(spec, this.op(spec, opId), { exampleName });
  }

  async send(spec, { opId, request, target, lenientAllOf }) {
    const op = this.op(spec, opId);
    const t = { ...spec.target, ...(target || {}) };
    const req = request || defaultRequest(spec, op);
    const r = await execute(this.ctx, spec, op, req, t, {});
    const checks = r.error ? r.checks : validateResponse(spec, this.validator(spec, lenientAllOf ?? spec.options?.lenientAllOf), op, r.response);
    const outcome = summarize(checks);
    const out = { opId: op.id, ...r, checks, outcome, pass: outcome !== 'fail' };
    if (out.response) delete out.response.json;
    return out;
  }

  async run(spec, { negative = false, variables = {}, operationIds, target, lenientAllOf } = {}) {
    const startedAt = new Date();
    const lenient = lenientAllOf ?? spec.options?.lenientAllOf;
    const t = { ...spec.target, ...(target || {}) };
    const result = await runAll(this.ctx, spec, this.validator(spec, lenient), { target: t, negative, variables, operationIds });
    const run = {
      id: `run_${crypto.randomBytes(6).toString('hex')}`,
      specId: spec.id,
      specName: spec.name,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      target: { ...t, auth: maskAuth(t.auth) },
      options: { negative, lenientAllOf: !!lenient, operationIds: operationIds || null },
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

  profiles(spec) { return profilesFromSpec(spec.doc); }

  async mock(spec, req) {
    const r = await installMock(this.ctx, spec, slugify(spec.name));
    return { ...r, url: `${this.ctx.baseUrl(req)}${r.prefix}` };
  }

  async unmock(spec) { return removeMock(this.ctx, slugify(spec.name)); }
}

module.exports = { TesterService };
