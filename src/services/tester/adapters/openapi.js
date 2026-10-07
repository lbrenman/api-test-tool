'use strict';
// OpenAPI 3.0 / 3.1 / Swagger 2.0 contract adapter. Thin wrapper over the original tester modules
// (load, lint, operations, runner, validate, auth, mock), which keep their behaviour unchanged.
const { loadSpec } = require('../load');
const { lintSpec } = require('../lint');
const { SpecValidator } = require('../validate');
const { listOperations } = require('../operations');
const { defaultRequest, execute, validateResponse, runAll, summarize, serverUrl } = require('../runner');
const { profilesFromSpec } = require('../auth');
const { installMock, removeMock, slugify } = require('../mock');
const { HttpError } = require('../../../util/problem');

class OpenApiAdapter {
  constructor(ctx) {
    this.ctx = ctx;
    this.kind = 'openapi';
    this.label = 'OpenAPI';
    this.validators = new Map();
  }

  /** Anything that is not XML is treated as OpenAPI (YAML or JSON). */
  detect(text) {
    return !/^\s*(﻿)?</.test(String(text || ''));
  }

  async load({ content, url }) {
    const loaded = await loadSpec({ content, url });
    return {
      doc: loaded.doc,
      title: loaded.title,
      apiVersion: loaded.apiVersion,
      version: loaded.version,
      originalVersion: loaded.originalVersion,
      converted: loaded.converted,
      notes: loaded.notes,
      structural: loaded.structural,
      defaultTarget: { baseUrl: serverUrl(loaded.doc) },
      options: { lenientAllOf: false },
    };
  }

  invalidate(specId) {
    for (const k of [...this.validators.keys()]) if (k.startsWith(`${specId}|`)) this.validators.delete(k);
  }

  validator(spec, lenient = spec.options?.lenientAllOf) {
    const key = `${spec.id}|${spec.updatedAt}|${!!lenient}`;
    if (!this.validators.has(key)) this.validators.set(key, new SpecValidator(spec.doc, { version: spec.version, lenientAllOf: !!lenient }));
    return this.validators.get(key);
  }

  lint(spec) { return lintSpec(spec); }

  operationCount(spec) { return listOperations(spec.doc).length; }

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
    const req = request || defaultRequest(spec, op);
    const r = await execute(this.ctx, spec, op, req, target, {});
    const checks = r.error ? r.checks : validateResponse(spec, this.validator(spec, lenientAllOf ?? spec.options?.lenientAllOf), op, r.response);
    const outcome = summarize(checks);
    const out = { opId: op.id, ...r, checks, outcome, pass: outcome !== 'fail' };
    if (out.response) delete out.response.json;
    return out;
  }

  async run(spec, { target, negative, variables, operationIds, lenientAllOf }) {
    const lenient = lenientAllOf ?? spec.options?.lenientAllOf;
    const result = await runAll(this.ctx, spec, this.validator(spec, lenient), { target, negative, variables, operationIds });
    return { ...result, options: { lenientAllOf: !!lenient } };
  }

  profiles(spec) { return profilesFromSpec(spec.doc); }

  async mock(spec, req) {
    const r = await installMock(this.ctx, spec, slugify(spec.name));
    return { ...r, url: `${this.ctx.baseUrl(req)}${r.prefix}` };
  }

  async unmock(spec) { return removeMock(this.ctx, slugify(spec.name)); }

  /** The raw contract for "View" in the dashboard. */
  document(spec) { return { contentType: 'application/json', body: JSON.stringify(spec.doc) }; }
}

module.exports = { OpenApiAdapter };
