'use strict';
// Which commit this process is running, reported by /health and the admin overview.
// Order: the GIT_SHA environment variable (baked into Docker images with `--build-arg GIT_SHA=…`),
// then the checkout's .git directory (Codespaces, local runs), else null.
const fs = require('node:fs');
const path = require('node:path');

const SHA = /^[0-9a-f]{7,40}$/i;

function fromGit(root) {
  try {
    const gitDir = path.join(root, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return SHA.test(head) ? head : null; // detached HEAD
    const ref = head.slice(5);
    try {
      const sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
      if (SHA.test(sha)) return sha;
    } catch { /* not a loose ref: look in packed-refs */ }
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    const sha = line && line.split(' ')[0];
    return sha && SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function resolveCommit(env = process.env, root = path.join(__dirname, '..', '..')) {
  const fromEnv = String(env.GIT_SHA || '').trim();
  if (SHA.test(fromEnv)) return fromEnv.toLowerCase();
  return fromGit(root);
}

const commit = resolveCommit();

module.exports = { commit, resolveCommit };
