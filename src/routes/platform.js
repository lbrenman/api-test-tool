'use strict';
// /health, /ready, /openapi.json|yaml, /docs (Swagger UI), /samples/* (bundled specs).
const express = require('express');
const path = require('node:path');
const yaml = require('js-yaml');
const { generateOpenApi } = require('../services/openapiGen');
const pkg = require('../../package.json');

const STARTED = Date.now();

module.exports = function platformRouter(ctx) {
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

  r.get('/docs', (req, res) => {
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Test Tool · API docs</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css">
<style>body{margin:0}.topbar{display:none}</style></head><body><div id="ui"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js"></script>
<script>window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#ui', deepLinking: true, persistAuthorization: true,
  oauth2RedirectUrl: location.origin + '/docs/oauth2-redirect' });
window.ui.initOAuth({ clientId: 'demo-client', usePkceWithAuthorizationCodeGrant: true });</script></body></html>`);
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
