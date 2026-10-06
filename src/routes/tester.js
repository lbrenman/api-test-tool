'use strict';
// /admin/api/tester/* — incoming API tester backend.
const express = require('express');
const { HttpError } = require('../util/problem');
const { htmlReport } = require('../services/tester/report');
const { fetchToken, clearTokenCache } = require('../services/tester/auth');

function readUpload(req) {
  return new Promise((resolve, reject) => {
    const Busboy = require('busboy');
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
    const fields = {};
    let content = null;
    bb.on('field', (k, v) => { fields[k] = v; });
    bb.on('file', (_k, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => { content = Buffer.concat(chunks).toString('utf8'); fields.filename = info.filename; });
    });
    bb.on('close', () => resolve({ ...fields, content }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

module.exports = function testerRouter(ctx) {
  const { tester } = ctx;
  const r = express.Router();

  r.get('/samples', async (req, res) => res.json(await tester.samples()));

  r.get('/specs', async (req, res) => res.json(await tester.list()));

  r.post('/specs', async (req, res) => {
    let body = req.body || {};
    if (/multipart\/form-data/i.test(req.get('content-type') || '')) body = await readUpload(req);
    if (!body.content && !body.url && !body.sample) throw new HttpError(400, 'Provide content (pasted/uploaded YAML or JSON), url, or sample');
    const spec = await tester.create({ name: body.name || (body.filename ? body.filename.replace(/\.(ya?ml|json)$/i, '') : undefined), content: body.content, url: body.url, sample: body.sample, source: body.filename ? { type: 'upload', filename: body.filename } : undefined }, req);
    res.status(201).json({ id: spec.id, name: spec.name, version: spec.version, originalVersion: spec.originalVersion, notes: spec.notes, lint: tester.lint(spec).counts });
  });

  r.get('/specs/:id', async (req, res) => {
    const s = await tester.get(req.params.id);
    res.json({ ...s, operations: tester.operations(s), profiles: tester.profiles(s), lint: tester.lint(s).counts });
  });

  r.get('/specs/:id/document', async (req, res) => res.json((await tester.get(req.params.id)).doc));

  r.put('/specs/:id', async (req, res) => {
    const s = await tester.update(req.params.id, req.body || {});
    res.json({ id: s.id, name: s.name, target: s.target, options: s.options, updatedAt: s.updatedAt });
  });

  r.post('/specs/:id/reload', async (req, res) => {
    const s = await tester.reload(req.params.id, req);
    res.json({ id: s.id, updatedAt: s.updatedAt, lint: tester.lint(s).counts });
  });

  r.delete('/specs/:id', async (req, res) => { await tester.remove(req.params.id); res.status(204).end(); });

  r.get('/specs/:id/lint', async (req, res) => res.json(tester.lint(await tester.get(req.params.id))));

  r.get('/specs/:id/operations', async (req, res) => res.json(tester.operations(await tester.get(req.params.id))));

  r.get('/specs/:id/request', async (req, res) => {
    const s = await tester.get(req.params.id);
    if (!req.query.op) throw new HttpError(400, 'op query parameter required');
    res.json(tester.defaultRequest(s, String(req.query.op), req.query.example ? String(req.query.example) : undefined));
  });

  r.post('/specs/:id/send', async (req, res) => {
    const s = await tester.get(req.params.id);
    const b = req.body || {};
    if (!b.opId) throw new HttpError(400, 'opId required');
    res.json(await tester.send(s, b));
  });

  r.post('/specs/:id/runs', async (req, res) => {
    const s = await tester.get(req.params.id);
    const run = await tester.run(s, req.body || {});
    res.status(201).json(run);
  });

  r.get('/specs/:id/runs', async (req, res) => res.json(await tester.runs(req.params.id)));

  r.post('/specs/:id/mock', async (req, res) => {
    const s = await tester.get(req.params.id);
    const m = await tester.mock(s, req);
    if (req.body?.useAsTarget) await tester.update(s.id, { target: { baseUrl: m.url } });
    res.status(201).json(m);
  });

  r.delete('/specs/:id/mock', async (req, res) => {
    const s = await tester.get(req.params.id);
    res.json({ removed: await tester.unmock(s) });
  });

  r.post('/token', async (req, res) => {
    const auth = req.body?.auth;
    if (!auth || auth.type !== 'oauth2cc') throw new HttpError(400, 'auth.type must be oauth2cc');
    try {
      const t = await fetchToken(auth, { force: true });
      res.json({ ok: true, exchange: t.exchange });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message, exchange: e.exchange || null });
    }
  });

  r.post('/token-cache/clear', (req, res) => { clearTokenCache(); res.json({ cleared: true }); });

  r.get('/runs', async (req, res) => res.json(await tester.runs()));
  r.get('/runs/:runId', async (req, res) => res.json(await tester.getRun(req.params.runId)));
  r.delete('/runs/:runId', async (req, res) => { await tester.deleteRun(req.params.runId); res.status(204).end(); });
  r.get('/runs/:runId/report.html', async (req, res) => {
    const run = await tester.getRun(req.params.runId);
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${run.id}.html"`);
    res.type('html').send(htmlReport(run));
  });
  r.get('/runs/:runId/export.json', async (req, res) => {
    const run = await tester.getRun(req.params.runId);
    res.setHeader('Content-Disposition', `attachment; filename="${run.id}.json"`);
    res.json(run);
  });

  return r;
};
