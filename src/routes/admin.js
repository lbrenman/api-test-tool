'use strict';
// /admin/api/* — backend for the dashboard (password protected).
const express = require('express');
const { seedAll, clearAll } = require('../services/seed');
const { generateSamples } = require('../services/sampleFiles');
const { NAMES } = require('../services/resources');
const { HttpError } = require('../util/problem');
const { hmacCanonical } = require('../middleware/auth');
const testerRouter = require('./tester');
const pkg = require('../../package.json');

module.exports = function adminRouter(ctx, { adminAuth, filesApi }) {
  const r = express.Router();
  const { settings, repo, resources, files, inspector, oauth, baseUrl } = ctx;
  r.use(express.json({ limit: '20mb' }));
  r.use(express.urlencoded({ extended: false }));

  // ---- session (public)
  r.get('/session', (req, res) => res.json({ authenticated: adminAuth.valid(req), passwordRequired: adminAuth.enabled() }));
  r.post('/login', (req, res) => {
    if (adminAuth.login(req, res)) return res.json({ ok: true });
    res.status(401).json({ ok: false, error: 'Invalid password' });
  });
  r.post('/logout', (req, res) => { adminAuth.logout(req, res); res.json({ ok: true }); });

  r.use(adminAuth.requireApi);

  // ---- overview
  r.get('/overview', async (req, res) => {
    const base = baseUrl(req);
    const mode = settings.get('authMode');
    const authHeader = {
      none: '', apikey: settings.get('apiKeyIn') === 'header' ? ` -H '${settings.get('apiKeyName')}: ${settings.get('apiKey')}'` : '',
      basic: ` -u '${settings.get('basicUser')}:${settings.get('basicPass')}'`, bearer: ` -H 'Authorization: Bearer ${settings.get('bearerToken')}'`,
      jwt: " -H \"Authorization: Bearer $TOKEN\"", oauth2: " -H \"Authorization: Bearer $TOKEN\"", hmac: ' -H "Authorization: HMAC …" -H "X-Timestamp: …"',
    }[mode];
    const q = mode === 'apikey' && settings.get('apiKeyIn') === 'query' ? `?${settings.get('apiKeyName')}=${settings.get('apiKey')}` : '';
    const curls = [
      `curl -s ${base}/v1/employees${q ? `${q}&` : '?'}limit=2${authHeader}`,
      `curl -s "${base}/v1/p/cursor/products?limit=5${q ? `&${q.slice(1)}` : ''}"${authHeader}`,
      `curl -s -X POST ${base}/hooks/my-webhook -H 'Content-Type: application/json' -d '{"hello":"inspector"}'`,
      `curl -s -i ${base}/v1/employees/1${q} -H 'X-Force-Error: 503'${authHeader}`,
    ];
    if (mode === 'jwt' || mode === 'oauth2') curls.unshift(`TOKEN=$(curl -s -u demo-client:demo-secret -d grant_type=client_credentials ${base}/oauth/token | sed -E 's/.*"access_token":"([^"]+)".*/\\1/')`);
    res.json({
      version: pkg.version,
      baseUrl: base,
      urls: { api: `${base}/v1`, docs: `${base}/docs`, openapi: `${base}/openapi.json`, health: `${base}/health`, inspector: `${base}/<any-other-path>`, token: `${base}/oauth/token` },
      authMode: mode,
      dateFormat: settings.get('dateFormat'),
      chaos: { errorRate: settings.get('errorRate'), errorTypes: settings.get('errorTypes'), latency: [settings.get('latencyMinMs'), settings.get('latencyMaxMs')] },
      storage: { db: repo.name, files: files.store.name },
      counts: await resources.counts(),
      files: (await files.list()).length,
      inspector: await repo.count('inspector'),
      lastSeed: await repo.kvGet('seed:last'),
      curls,
      warnings: [
        ...(!settings.get('adminPassword') ? ['ADMIN_PASSWORD is not set — the dashboard is open to anyone who can reach this URL.'] : []),
      ],
    });
  });

  // ---- settings
  r.get('/settings', (req, res) => res.json({ sections: settings.sections(), settings: settings.describe() }));
  r.put('/settings', async (req, res) => {
    const out = await settings.setMany(req.body || {});
    res.json({ updated: out, settings: settings.describe() });
  });
  r.post('/settings/reset', async (req, res) => {
    const keys = await settings.reset({ key: req.body?.key, section: req.body?.section });
    res.json({ reset: keys, settings: settings.describe() });
  });

  // ---- data
  r.get('/data/counts', async (req, res) => res.json(await resources.counts()));
  r.post('/data/seed', async (req, res) => {
    const b = req.body || {};
    const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const result = await seedAll(ctx, { employees: num(b.employees), products: num(b.products), seed: num(b.seed) });
    let samples = null;
    if (b.sampleFiles ?? settings.get('seedSampleFiles')) samples = (await generateSamples(ctx)).length;
    res.json({ ...result, sampleFiles: samples });
  });
  r.post('/data/clear', async (req, res) => { await clearAll(ctx); res.json({ cleared: true, counts: await resources.counts() }); });
  r.get('/data/preview/:resource', async (req, res) => {
    if (!NAMES.includes(req.params.resource)) throw new HttpError(404, 'Unknown resource');
    const limit = Math.min(Number(req.query.limit) || 5, 50);
    const docs = (await resources.all(req.params.resource)).slice(0, limit);
    res.json(ctx.dates.formatDoc(await resources.render(req.params.resource, docs)));
  });

  // ---- files
  r.get('/files', async (req, res) => res.json((await files.list()).map((f) => filesApi.present(req, f))));
  r.post('/files/regenerate', async (req, res) => res.json({ generated: (await generateSamples(ctx)).length }));
  r.post('/files/upload', async (req, res) => {
    const name = req.get('x-filename') ? decodeURIComponent(req.get('x-filename')) : 'upload.bin';
    // The dashboard sends application/octet-stream (so no body parser touches it) and the real type in X-Content-Type.
    const contentType = (req.get('x-content-type') || req.get('content-type') || 'application/octet-stream').split(';')[0];
    const meta = await files.saveStream({ name, contentType, source: 'uploaded', stream: req });
    res.status(201).json(filesApi.present(req, meta));
  });
  r.delete('/files/:id', async (req, res) => {
    if (!(await files.remove(req.params.id))) throw new HttpError(404, 'File not found');
    res.status(204).end();
  });
  r.get('/files/:id/download', async (req, res) => filesApi.sendFile(req, res, await files.mustGet(req.params.id), { inline: req.query.inline === 'true' }));

  // ---- auth / oauth
  r.get('/auth', async (req, res) => {
    res.json({
      mode: settings.get('authMode'),
      apiKey: { name: settings.get('apiKeyName'), in: settings.get('apiKeyIn'), value: settings.get('apiKey') },
      basic: { user: settings.get('basicUser'), pass: settings.get('basicPass') },
      bearer: settings.get('bearerToken'),
      jwt: { alg: settings.get('jwtAlg'), issuer: oauth.issuer(req), audience: oauth.audience(), jwks: `${baseUrl(req)}/.well-known/jwks.json` },
      hmac: { keyId: settings.get('hmacKeyId'), secret: settings.get('hmacSecret'), maxSkewSeconds: settings.get('hmacMaxSkewSeconds') },
      oauth: { tokenUrl: `${baseUrl(req)}/oauth/token`, authorizeUrl: `${baseUrl(req)}/oauth/authorize`, metadata: `${baseUrl(req)}/.well-known/oauth-authorization-server`, users: oauth.users().map((u) => u.username) },
      clients: await oauth.clients(),
    });
  });
  r.post('/oauth/clients', async (req, res) => res.status(201).json(await oauth.addClient(req.body || {})));
  r.delete('/oauth/clients/:id', async (req, res) => {
    if (!(await oauth.removeClient(req.params.id))) throw new HttpError(404, 'Only dashboard-added clients can be deleted (env clients come from OAUTH_CLIENTS)');
    res.status(204).end();
  });
  r.post('/auth/test-token', async (req, res) => {
    const clients = await oauth.clients();
    const client = clients.find((c) => c.clientId === req.body?.clientId) || clients[0];
    if (!client) throw new HttpError(400, 'No OAuth clients configured');
    const scopes = oauth.resolveScopes(client, req.body?.scope);
    const tok = await oauth.issueAccessToken(req, { client, scopes });
    res.json({ ...tok, clientId: client.clientId, decoded: ctx.keys.decode(tok.access_token) });
  });
  r.post('/auth/hmac-sign', (req, res) => {
    const b = req.body || {};
    const date = String(Math.floor(Date.now() / 1000));
    const fake = { method: String(b.method || 'GET').toUpperCase(), originalUrl: b.path || '/v1/employees', rawBody: b.body ? Buffer.from(String(b.body)) : undefined, get: () => undefined };
    const canonical = hmacCanonical(fake, date);
    const sig = require('node:crypto').createHmac('sha256', settings.get('hmacSecret')).update(canonical).digest('base64');
    res.json({ canonical, headers: { Authorization: `HMAC ${settings.get('hmacKeyId')}:${sig}`, 'X-Timestamp': date } });
  });

  // ---- inspector
  r.get('/inspector', async (req, res) => res.json(await inspector.list(Number(req.query.limit) || 200)));
  r.get('/inspector/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const send = (event) => (data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onReq = send('request');
    const onUpd = send('update');
    const onClear = send('clear');
    inspector.on('request', onReq);
    inspector.on('update', onUpd);
    inspector.on('clear', onClear);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      inspector.off('request', onReq);
      inspector.off('update', onUpd);
      inspector.off('clear', onClear);
    });
  });
  r.get('/inspector/export', async (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="inspector-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json"`);
    res.json(await inspector.exportAll());
  });
  r.delete('/inspector', async (req, res) => { await inspector.clear(); res.status(204).end(); });
  r.get('/inspector/:id', async (req, res) => {
    const e = await inspector.get(req.params.id);
    if (!e) throw new HttpError(404, 'Capture not found');
    res.json({ ...e, curl: inspector.toCurl(e) });
  });
  r.get('/inspector/:id/body', async (req, res) => {
    const e = await inspector.get(req.params.id);
    if (!e || !e.body?.base64) throw new HttpError(404, 'No body');
    res.setHeader('Content-Type', e.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="capture-${e.id}.bin"`);
    res.send(Buffer.from(e.body.base64, 'base64'));
  });
  r.get('/inspector/:id/parts/:n', async (req, res) => {
    const e = await inspector.get(req.params.id);
    const part = e?.body?.multipart?.parts?.[Number(req.params.n)];
    if (!part || part.type !== 'file' || !part.base64) throw new HttpError(404, 'Part not available');
    res.setHeader('Content-Type', part.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${String(part.filename || 'part.bin').replace(/"/g, '')}"`);
    res.send(Buffer.from(part.base64, 'base64'));
  });
  r.post('/inspector/:id/replay', async (req, res) => {
    const e = await inspector.get(req.params.id);
    if (!e) throw new HttpError(404, 'Capture not found');
    res.json(await inspector.replay(e, req.body?.targetUrl, req));
  });
  r.get('/inspector/:id/curl', async (req, res) => {
    const e = await inspector.get(req.params.id);
    if (!e) throw new HttpError(404, 'Capture not found');
    res.type('text/plain').send(inspector.toCurl(e, req.query.target));
  });

  r.use('/tester', testerRouter(ctx));
  return r;
};
