'use strict';
// /v1 CRUD for employees, products, departments, categories (+ nested collections and pagination variants).
const express = require('express');
const { NAMES, etagOf } = require('../services/resources');
const { applyQuery, parseFields, project } = require('../services/query');
const { paginate, SCHEMES } = require('../services/paginate');
const { HttpError } = require('../util/problem');

const NESTED = { departments: { child: 'employees', fk: 'departmentId' }, categories: { child: 'products', fk: 'categoryId' } };

module.exports = function resourcesRouter(ctx) {
  const r = express.Router();
  const { resources, dates, baseUrl } = ctx;

  function resourceParam(req) {
    const name = req.params.resource;
    if (!NAMES.includes(name)) throw new HttpError(404, `Unknown resource "${name}"`, { code: 'unknown-resource' });
    return name;
  }

  async function renderOne(name, doc) {
    const [out] = await resources.render(name, [doc]);
    return dates.formatDoc(out);
  }

  async function sendList(req, res, name, docs, scheme) {
    const rendered = await resources.render(name, docs);
    const filtered = applyQuery(rendered, req.query, { parseDate: dates.parseValue, ignore: [ctx.settings.get('apiKeyName')] });
    const fields = parseFields(req.query.fields);
    const { body, headers } = paginate(scheme, req, filtered, {
      baseUrl, name, render: (slice) => slice.map((d) => project(dates.formatDoc(d), fields)),
    });
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (headers['Content-Type']) return res.send(JSON.stringify(body));
    return res.json(body);
  }

  async function loadItem(req) {
    const name = resourceParam(req);
    const doc = await resources.get(name, req.params.id);
    if (!doc) throw new HttpError(404, `${name.replace(/s$/, '').replace(/ie$/, 'y')} ${req.params.id} not found`, { code: 'not-found' });
    return { name, doc };
  }

  async function checkIfMatch(req, name, doc) {
    const im = req.get('if-match');
    if (!im) return;
    if (im.trim() === '*') return;
    const current = etagOf(await renderOne(name, doc));
    const list = im.split(',').map((s) => s.trim().replace(/^W\//, ''));
    if (!list.includes(current)) {
      throw new HttpError(412, 'If-Match does not match the current ETag', { code: 'precondition-failed', errors: [{ field: 'header:If-Match', message: `current ETag is ${current}` }] });
    }
  }

  function requireJson(req, { patch = false } = {}) {
    const ct = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ok = ['application/json', ...(patch ? ['application/merge-patch+json'] : [])];
    if (!ct) throw new HttpError(415, `Content-Type must be ${ok.join(' or ')}`, { code: 'unsupported-media-type' });
    if (!ok.includes(ct) && !ct.endsWith('+json')) throw new HttpError(415, `Content-Type ${ct} is not supported; use ${ok.join(' or ')}`, { code: 'unsupported-media-type' });
    if (req.body === undefined) throw new HttpError(400, 'A JSON request body is required');
  }

  async function sendItem(res, name, doc, status = 200) {
    const out = await renderOne(name, doc);
    res.setHeader('ETag', etagOf(out));
    res.setHeader('Last-Modified', new Date(doc.updatedAt).toUTCString());
    return out;
  }

  // ---- pagination variants: /v1/p/{scheme}/{resource}
  r.get('/p/:scheme/:resource', async (req, res) => {
    const name = resourceParam(req);
    if (!SCHEMES.includes(req.params.scheme)) throw new HttpError(404, `Unknown pagination scheme "${req.params.scheme}". Use one of: ${SCHEMES.join(', ')}`);
    await sendList(req, res, name, await resources.all(name), req.params.scheme);
  });

  // ---- nested collections
  r.get('/:resource/:id/:child', async (req, res, next) => {
    const nest = NESTED[req.params.resource];
    if (!nest || nest.child !== req.params.child) return next();
    const { doc } = await loadItem(req);
    const children = (await resources.all(nest.child)).filter((c) => c[nest.fk] === doc.id);
    await sendList(req, res, nest.child, children, 'offset');
  });

  // ---- collection
  r.get('/:resource', async (req, res) => {
    const name = resourceParam(req);
    await sendList(req, res, name, await resources.all(name), 'offset');
  });

  r.post('/:resource', async (req, res) => {
    const name = resourceParam(req);
    requireJson(req);
    const doc = await resources.create(name, req.body);
    const out = await sendItem(res, name, doc);
    res.setHeader('Location', `${baseUrl(req)}/v1/${name}/${doc.id}`);
    res.status(201).json(out);
  });

  // ---- item
  r.get('/:resource/:id', async (req, res) => {
    const { name, doc } = await loadItem(req);
    const out = await sendItem(res, name, doc);
    // Explicit If-None-Match wins even when the client also sends Cache-Control: no-cache (Postman does).
    const inm = req.get('if-none-match');
    if (inm && (inm.trim() === '*' || inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(res.get('ETag')))) {
      return res.status(304).end();
    }
    res.json(project(out, parseFields(req.query.fields)));
  });

  r.put('/:resource/:id', async (req, res) => {
    const { name, doc } = await loadItem(req);
    requireJson(req);
    await checkIfMatch(req, name, doc);
    const updated = await resources.replace(name, doc, req.body);
    res.json(await sendItem(res, name, updated));
  });

  r.patch('/:resource/:id', async (req, res) => {
    const { name, doc } = await loadItem(req);
    requireJson(req, { patch: true });
    await checkIfMatch(req, name, doc);
    const updated = await resources.patch(name, doc, req.body);
    res.json(await sendItem(res, name, updated));
  });

  r.delete('/:resource/:id', async (req, res) => {
    const { name, doc } = await loadItem(req);
    await checkIfMatch(req, name, doc);
    await resources.remove(name, doc);
    res.status(204).end();
  });

  return r;
};
