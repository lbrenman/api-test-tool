'use strict';
// npm run postman                 -> boots a fresh server per auth mode and runs the collection with Newman
// npm run postman -- --mode hmac  -> one mode only
// npm run postman -- --url https://my-app.fly.dev --mode none   -> run against an existing server (no boot)
// npm run postman -- --profiles   -> same, but through the settings profile /p/<mode> on a server whose global
//                                    AUTH_MODE is a different mode (proves profiles isolate auth for every protocol)
// npm run postman -- --mode mtls   -> the whole collection on the mTLS listener, authenticated by a client certificate
// Booted servers also run the mTLS listener: the collection's "Mutual TLS" folder gets two lab CA client certificates
// (one per host name, 127.0.0.1 and localhost) and skips itself when {{mtlsUrl}} is not set (e.g. --url runs).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { mtlsSetup } = require('./mtls-newman-setup');

const ALL = ['none', 'apikey', 'basic', 'bearer', 'jwt', 'oauth2', 'hmac', 'mtls'];
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

// The global mode a --profiles run boots with: never the mode under test, so a request that escapes the profile fails.
const otherMode = (mode) => (mode === 'bearer' ? 'basic' : 'bearer');

function runNewman(baseUrl, mode, label = mode, mtls = null) {
  const newman = require('newman');
  return new Promise((resolve) => {
    newman.run({
      collection: require(path.join(root, 'postman/API-Test-Tool.postman_collection.json')),
      environment: require(path.join(root, 'postman/API-Test-Tool.postman_environment.json')),
      envVar: [{ key: 'baseUrl', value: baseUrl }, { key: 'authMode', value: mode }, ...(mtls?.env || [])],
      ...(mtls?.newman || {}),
      workingDir: path.join(root, 'postman'),
      reporters: ['cli', 'junit'],
      reporter: { junit: { export: path.join(root, `newman-results/${label}.xml`) } },
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
  const profiles = process.argv.includes('--profiles');
  const results = {};
  for (const mode of modes) {
    if (external) { results[mode] = await runNewman(`${external.replace(/\/+$/, '')}${profiles ? `/p/${mode}` : ''}`, mode); continue; }
    const port = await freePort();
    const mtlsPort = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `att-newman-${mode}-`));
    const env = {
      ...process.env, PORT: String(port), AUTH_MODE: profiles ? otherMode(mode) : mode, DB_DRIVER: 'sqlite', FILE_STORE: 'local',
      MTLS_ENABLED: 'true', MTLS_PORT: String(mtlsPort),
      SQLITE_PATH: path.join(dir, 'app.db'), FILE_DIR: path.join(dir, 'files'), PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      SEED_ON_START: 'always', LOG_LEVEL: 'warn', ADMIN_PASSWORD: '',
    };
    const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
    try {
      await waitFor(`http://127.0.0.1:${port}/ready`);
      const mtls = await mtlsSetup(`http://127.0.0.1:${port}`, mtlsPort, dir);
      // In mtls mode the whole collection runs on the mTLS listener (certificate a), so every protocol is checked over it.
      const server = mode === 'mtls' ? `https://127.0.0.1:${mtlsPort}` : `http://127.0.0.1:${port}`;
      if (profiles) {
        console.log(`\n===== Newman · profile /p/${mode} (global AUTH_MODE=${otherMode(mode)}) =====`);
        results[`p/${mode}`] = await runNewman(`${server}/p/${mode}`, mode, `profile-${mode}`, mtls);
      } else {
        console.log(`\n===== Newman · AUTH_MODE=${mode} =====`);
        results[mode] = await runNewman(server, mode, mode, mtls);
      }
    } finally {
      child.kill('SIGTERM');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log('\nResults:', results);
  process.exit(Object.values(results).every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
