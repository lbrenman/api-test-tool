'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');

// Storage backends for tests:
//   default                 -> SQLite file + local file dir (per app, in a temp dir)
//   TEST_DB_DRIVER=postgres -> a fresh database per app, created via TEST_DATABASE_URL (admin connection)
//   TEST_FILE_STORE=s3      -> S3-compatible bucket from S3_* env, with a unique S3_PREFIX per app
const created = new Map();

async function storageEnv(tmp) {
  const env = {};
  if (process.env.TEST_DB_DRIVER === 'postgres') {
    const key = path.basename(tmp);
    if (!created.has(key)) {
      const { Client } = require('pg');
      const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      const db = `att_${crypto.randomBytes(5).toString('hex')}`;
      await admin.query(`CREATE DATABASE ${db}`);
      await admin.end();
      const u = new URL(process.env.TEST_DATABASE_URL);
      u.pathname = `/${db}`;
      created.set(key, u.toString());
    }
    Object.assign(env, { DB_DRIVER: 'postgres', DATABASE_URL: created.get(key) });
  }
  if (process.env.TEST_FILE_STORE === 's3') {
    Object.assign(env, {
      FILE_STORE: 's3',
      S3_BUCKET: process.env.S3_BUCKET,
      S3_REGION: process.env.S3_REGION || 'us-east-1',
      S3_ENDPOINT: process.env.S3_ENDPOINT,
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
      S3_FORCE_PATH_STYLE: 'true',
      S3_PREFIX: `test/${path.basename(tmp)}/`,
    });
  }
  return env;
}

// Isolated app with its own database and file storage.
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
    ...(await storageEnv(tmp)),
  };
  // Only pass our variables (not the host's) so CI and dev shells behave the same.
  const { app, ctx, close } = await createApp({ env: { ...base, ...env } });
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
