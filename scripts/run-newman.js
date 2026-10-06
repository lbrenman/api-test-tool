'use strict';
// npm run postman                 -> boots a fresh server per auth mode and runs the collection with Newman
// npm run postman -- --mode hmac  -> one mode only
// npm run postman -- --url https://my-app.fly.dev --mode none   -> run against an existing server (no boot)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ALL = ['none', 'apikey', 'basic', 'bearer', 'jwt', 'oauth2', 'hmac'];
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const root = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server did not become healthy at ${url}`);
}

function runNewman(baseUrl, mode) {
  const newman = require('newman');
  return new Promise((resolve) => {
    newman.run({
      collection: require(path.join(root, 'postman/API-Test-Tool.postman_collection.json')),
      environment: require(path.join(root, 'postman/API-Test-Tool.postman_environment.json')),
      envVar: [{ key: 'baseUrl', value: baseUrl }, { key: 'authMode', value: mode }],
      workingDir: path.join(root, 'postman'),
      reporters: ['cli', 'junit'],
      reporter: { junit: { export: path.join(root, `newman-results/${mode}.xml`) } },
      timeoutRequest: 30000,
    }, (err, summary) => {
      if (err) { console.error(err); return resolve(false); }
      resolve(summary.run.failures.length === 0);
    });
  });
}

(async () => {
  const modes = arg('mode') ? [arg('mode')] : ALL;
  const external = arg('url');
  const results = {};
  for (const mode of modes) {
    if (external) { results[mode] = await runNewman(external.replace(/\/+$/, ''), mode); continue; }
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `att-newman-${mode}-`));
    const env = {
      ...process.env, PORT: String(port), AUTH_MODE: mode, DB_DRIVER: 'sqlite', FILE_STORE: 'local',
      SQLITE_PATH: path.join(dir, 'app.db'), FILE_DIR: path.join(dir, 'files'), PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      SEED_ON_START: 'always', LOG_LEVEL: 'warn', ADMIN_PASSWORD: '',
    };
    const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
    try {
      await waitFor(`http://127.0.0.1:${port}/ready`);
      console.log(`\n===== Newman · AUTH_MODE=${mode} =====`);
      results[mode] = await runNewman(`http://127.0.0.1:${port}`, mode);
    } finally {
      child.kill('SIGTERM');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log('\nResults:', results);
  process.exit(Object.values(results).every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
