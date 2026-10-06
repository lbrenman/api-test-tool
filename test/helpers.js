'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

// Isolated app with its own SQLite file and file directory.
async function makeApp(env = {}, { dir } = {}) {
  const tmp = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'att-test-'));
  const base = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    SQLITE_PATH: path.join(tmp, 'app.db'),
    FILE_DIR: path.join(tmp, 'files'),
    SEED_EMPLOYEES: '40',
    SEED_PRODUCTS: '60',
    SEED_SAMPLE_FILES: 'true',
    PUBLIC_BASE_URL: 'http://localhost',
  };
  const merged = { ...base, ...env };
  // Only pass our variables (not the host's) so CI and dev shells behave the same.
  const { app, ctx, close } = await createApp({ env: merged });
  return { app, ctx, close, dir: tmp };
}

// Same app, listening on an ephemeral port (needed when the tool calls itself over HTTP).
async function listen(env = {}, opts = {}) {
  const made = await makeApp(env, opts);
  const server = await new Promise((resolve) => { const s = made.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  await made.ctx.settings.set('publicBaseUrl', url);
  return {
    ...made, server, url,
    stop: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await made.close(); },
  };
}

module.exports = { makeApp, listen };
