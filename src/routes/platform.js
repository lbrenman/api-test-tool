'use strict';
// /health, /ready, /openapi.json|yaml (mock data API spec), /docs (Swagger UI for the data and admin specs),
// /samples/* (bundled specs). The admin spec itself is served by the admin router at /admin/api/openapi.json|yaml.
const express = require('express');
const path = require('node:path');
const yaml = require('js-yaml');
const { generateOpenApi } = require('../services/openapiGen');
const pkg = require('../../package.json');

const STARTED = Date.now();

module.exports = function platformRouter(ctx, { adminAuth } = {}) {
  const r = express.Router();
  const { settings, repo, files, resources } = ctx;

  async function check(fn) {
    const t = Date.now();
    try {
      await fn();
      return { ok: true, latencyMs: Date.now() - t };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t, error: e.message };
    }
  }

  r.get('/health', async (req, res) => {
    const db = await check(() => repo.ping());
    const store = await check(() => files.store.ping());
    const ok = db.ok && store.ok;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      version: pkg.version,
      uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
      time: new Date().toISOString(),
      baseUrl: ctx.baseUrl(req),
      checks: { database: { driver: repo.name, ...db }, fileStore: { driver: files.store.name, ...store } },
      settings: {
        authMode: settings.get('authMode'),
        dateFormat: settings.get('dateFormat'),
        errorRate: settings.get('errorRate'),
        errorTypes: settings.get('errorTypes'),
        latencyMs: [settings.get('latencyMinMs'), settings.get('latencyMaxMs')],
        rateLimitRpm: settings.get('rateLimitRpm'),
        requiredHeaders: settings.get('requiredHeaders').map((h) => h.name),
        responseHeaders: settings.get('responseHeaders').map((h) => h.name),
        inspectorLogAll: settings.get('inspectorLogAll'),
        maxFileSizeMb: settings.get('maxFileSizeMb'),
        dashboardProtected: !!settings.get('adminPassword'),
      },
      data: db.ok ? await resources.counts() : undefined,
    });
  });

  r.get('/ready', async (req, res) => {
    const db = await check(() => repo.ping());
    res.status(ctx.ready && db.ok ? 200 : 503).json({ ready: !!(ctx.ready && db.ok) });
  });

  r.get('/openapi.json', async (req, res) => {
    res.json(await generateOpenApi(ctx, req));
  });

  r.get('/openapi.yaml', async (req, res) => {
    res.type('application/yaml').send(yaml.dump(await generateOpenApi(ctx, req), { noRefs: true, lineWidth: 120 }));
  });

  // Swagger UI for both documents. ?spec=admin shows the admin API (dashboard sign-in required when a password is set).
  r.get('/docs', (req, res) => {
    const isAdmin = req.query.spec === 'admin';
    const allowed = !isAdmin || !adminAuth || adminAuth.valid(req);
    const tab = (key, label, hint) => `<a class="tab${(key === 'admin') === isAdmin ? ' on' : ''}" href="/docs${key === 'admin' ? '?spec=admin' : ''}">${label}<span>${hint}</span></a>`;
    const intro = isAdmin
      ? 'Control plane for the tool: settings, data seeding, files, OAuth clients, the inspector and the contract tester, plus /health and /ready. For operators and scripts. Requires the dashboard password.'
      : 'The mock API your integrations call: /v1 resources, pagination schemes, files and the OAuth token endpoint. Import this spec into your integration platform or Postman.';
    const specUrl = isAdmin ? '/admin/api/openapi.json' : '/openapi.json';
    const ui = allowed
      ? `<div id="ui"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js"></script>
<script>window.ui = SwaggerUIBundle({ url: '${specUrl}', dom_id: '#ui', deepLinking: true, persistAuthorization: true,
  oauth2RedirectUrl: location.origin + '/docs/oauth2-redirect' });
${isAdmin ? '' : "window.ui.initOAuth({ clientId: 'demo-client', usePkceWithAuthorizationCodeGrant: true });"}</script>`
      : '<p class="gate">Sign in to the <a href="/dashboard">dashboard</a> first, then reload this page.</p>';
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Test Tool · ${isAdmin ? 'Admin API' : 'Mock Data API'} docs</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css">
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.topbar{display:none}
.att{background:#1f2937;color:#e5e7eb;padding:12px 20px}.att .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.att b{margin-right:12px}.tab{color:#cbd5e1;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid #374151;display:flex;flex-direction:column;font-size:14px}
.tab span{font-size:11px;color:#94a3b8}.tab.on{background:#2563eb;border-color:#2563eb;color:#fff}.tab.on span{color:#dbeafe}
.att p{margin:8px 0 0;font-size:13px;color:#cbd5e1;max-width:900px}.att a.dash{color:#93c5fd;margin-left:auto;font-size:13px}
.gate{padding:24px;font-size:15px}</style></head><body>
<div class="att"><div class="row"><b>API Test Tool</b>${tab('data', 'Mock Data API', 'for integrations · /openapi.json')}${tab('admin', 'Admin API', 'for operators · /admin/api/openapi.json')}<a class="dash" href="/dashboard">Dashboard →</a></div><p>${intro}</p></div>
${ui}</body></html>`);
  });

  r.get('/docs/oauth2-redirect', (req, res) => {
    // Minimal Swagger UI OAuth2 redirect handler (authorization code flow).
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>OAuth2 redirect</title><script>
(function () {
  var o = window.opener && window.opener.swaggerUIRedirectOauth2;
  if (!o) { document.body.textContent = 'No Swagger UI window found.'; return; }
  var raw = /code|token|error/.test(location.hash) ? location.hash.slice(1) : location.search.slice(1);
  var qp = {}; new URLSearchParams(raw).forEach(function (v, k) { qp[k] = v; });
  var flow = o.auth.schema.get('flow');
  var isValid = qp.state === o.state;
  if ((flow === 'accessCode' || flow === 'authorizationCode' || flow === 'authorization_code') && !o.auth.code) {
    if (!isValid) o.errCb({ authId: o.auth.name, source: 'auth', level: 'warning', message: 'OAuth state mismatch.' });
    if (qp.code) { delete o.state; o.auth.code = qp.code; o.callback({ auth: o.auth, redirectUrl: o.redirectUrl }); }
    else o.errCb({ authId: o.auth.name, source: 'auth', level: 'error', message: '[' + (qp.error || 'authorization failed') + '] ' + (qp.error_description || '') });
  } else {
    o.callback({ auth: o.auth, token: qp, isValid: isValid, redirectUrl: o.redirectUrl });
  }
  window.close();
})();
</script>`);
  });

  r.use('/samples', express.static(path.resolve(__dirname, '../../samples'), {
    setHeaders: (res, p) => { if (/\.ya?ml$/i.test(p)) res.setHeader('Content-Type', 'application/yaml; charset=utf-8'); },
    fallthrough: false,
  }));

  return r;
};
