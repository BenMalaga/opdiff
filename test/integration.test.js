// End-to-end test: builds a real git repo in a temp dir, tags two commits,
// and runs the CLI against it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'opdiff.js');

function sh(cwd, ...args) {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
}

function gitc(cwd, ...args) {
  return sh(cwd, 'git', '-c', 'user.name=opdiff-test', '-c', 'user.email=t@example.com', ...args);
}

function write(repo, rel, content) {
  mkdirSync(join(repo, dirname(rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

test('CLI end-to-end on a fixture repo', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'opdiff-it-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  gitc(repo, 'init', '-q', '-b', 'main');

  // v1
  write(repo, 'src/app.js', 'const x = process.env.OLD_FLAG;\nconst r = process.env.REDIS_URL;\napp.listen(3000);\n');
  write(repo, 'Dockerfile', 'FROM node:18-alpine\nEXPOSE 3000\n');
  write(repo, 'migrations/0001_init.sql', 'CREATE TABLE t (id int);\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'v1');
  gitc(repo, 'tag', 'v1');

  // v2
  write(repo, 'src/app.js', 'const x = process.env.NEW_FLAG;\nconst r = process.env.REDIS_URI;\napp.listen(4000);\n');
  write(repo, 'Dockerfile', 'FROM node:20-alpine\nEXPOSE 4000\n');
  write(repo, 'migrations/0002_more.sql', 'ALTER TABLE t ADD c int;\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'v2');
  gitc(repo, 'tag', 'v2');

  const out = sh(repo, process.execPath, BIN, 'v1..v2', '--json');
  const d = JSON.parse(out);

  assert.deepEqual(d.env.added.map((e) => e.name), ['NEW_FLAG']);
  assert.deepEqual(d.env.removed.map((e) => e.name), ['OLD_FLAG']);
  assert.deepEqual(
    d.env.renamed.map((r) => [r.from, r.to]),
    [['REDIS_URL', 'REDIS_URI']],
  );
  assert.deepEqual(d.migrations.added, ['migrations/0002_more.sql']);
  assert.deepEqual(d.baseImages, [
    { file: 'Dockerfile', changed: [{ from: 'node:18-alpine', to: 'node:20-alpine' }], added: [], removed: [] },
  ]);
  assert.deepEqual(d.ports.expose, [{ file: 'Dockerfile', added: ['4000'], removed: ['3000'] }]);
  assert.deepEqual(d.ports.listen.added.map((p) => p.port), ['4000']);
  assert.deepEqual(d.ports.listen.removed.map((p) => p.port), ['3000']);

  // Text mode renders without error and mentions the rename.
  const text = sh(repo, process.execPath, BIN, 'v1', 'v2', '--no-color');
  assert.match(text, /REDIS_URL -> REDIS_URI/);

  // Bad ref exits 2.
  let code = 0;
  try {
    sh(repo, process.execPath, BIN, 'v1..nope');
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 2);
});
