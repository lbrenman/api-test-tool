'use strict';
// The commit /health and the admin overview report (src/util/build.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCommit } = require('../src/util/build');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'att-build-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(root, '.git', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

test('GIT_SHA wins over the checkout', () => {
  const root = repo({ HEAD: 'ref: refs/heads/master\n', 'refs/heads/master': `${B}\n` });
  assert.equal(resolveCommit({ GIT_SHA: A.toUpperCase() }, root), A);
});

test('an empty or invalid GIT_SHA falls back to the checkout', () => {
  const root = repo({ HEAD: 'ref: refs/heads/master\n', 'refs/heads/master': `${B}\n` });
  assert.equal(resolveCommit({ GIT_SHA: '' }, root), B);
  assert.equal(resolveCommit({ GIT_SHA: 'not-a-sha' }, root), B);
});

test('reads a packed ref and a detached HEAD', () => {
  assert.equal(resolveCommit({}, repo({ HEAD: 'ref: refs/heads/main\n', 'packed-refs': `# pack-refs\n${A} refs/heads/main\n` })), A);
  assert.equal(resolveCommit({}, repo({ HEAD: `${B}\n` })), B);
});

test('null without GIT_SHA or a .git directory (e.g. a Docker image built without the arg)', () => {
  assert.equal(resolveCommit({}, fs.mkdtempSync(path.join(os.tmpdir(), 'att-build-'))), null);
});
