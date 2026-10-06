'use strict';
// Entry point: node src/server.js
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader (no dependency). Real environment variables win.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const { createApp } = require('./app');
const { hostBaseUrl } = require('./config/baseUrl');

async function main() {
  const { app, ctx, close } = await createApp();
  const port = ctx.settings.get('port');
  if (!ctx.settings.get('adminPassword')) {
    console.warn('[warn] ADMIN_PASSWORD is not set: the dashboard and /admin/api are open to anyone who can reach this server.');
  }
  const server = app.listen(port, () => {
    const base = ctx.settings.get('publicBaseUrl') || hostBaseUrl(process.env, port) || `http://localhost:${port}`;
    console.log(`[info] api-test-tool listening on :${port}`);
    console.log(`[info] dashboard  ${base}/dashboard`);
    console.log(`[info] mock API   ${base}/v1/employees   (auth: ${ctx.settings.get('authMode')})`);
    console.log(`[info] inspector  ${base}/<any other path>`);
    console.log(`[info] storage    db=${ctx.repo.name} files=${ctx.files.store.name}`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0; // chaos "timeout"/"slow-drip" and large uploads need long-lived requests

  const shutdown = (sig) => {
    console.log(`[info] ${sig} received, shutting down`);
    server.close(async () => {
      await close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
