import test from 'node:test';
import assert from 'node:assert/strict';
import {
  similarity,
  detectRenames,
  diffSurfaces,
  diffImageLists,
  imageRepo,
  isEmptyDiff,
  RENAME_THRESHOLD,
} from '../src/diff.js';
import { renderText, renderJson } from '../src/report.js';

function emptySurface() {
  return {
    env: new Map(),
    migrations: new Set(),
    dockerfiles: new Map(),
    composePorts: new Map(),
    listenPorts: new Map(),
  };
}

function envSurface(names) {
  const s = emptySurface();
  for (const [name, file, line] of names) {
    s.env.set(name, { sites: [{ file, line }] });
  }
  return s;
}

// --- similarity -------------------------------------------------------------

test('similarity: identical names score 1', () => {
  assert.equal(similarity('REDIS_URL', 'REDIS_URL'), 1);
});

test('similarity: near-renames clear the threshold', () => {
  assert.ok(similarity('REDIS_URL', 'REDIS_URI') >= RENAME_THRESHOLD);
  assert.ok(similarity('DATABASE_URL', 'DATABASE_DSN') >= RENAME_THRESHOLD);
  assert.ok(similarity('SMTP_HOST', 'EMAIL_SMTP_HOST') >= RENAME_THRESHOLD);
});

test('similarity: unrelated names stay below the threshold', () => {
  assert.ok(similarity('SMTP_HOST', 'REDIS_PORT') < RENAME_THRESHOLD);
  assert.ok(similarity('DEBUG', 'DATABASE_URL') < RENAME_THRESHOLD);
});

// --- rename detection -------------------------------------------------------

test('detectRenames: pairs best matches greedily, each name used once', () => {
  const removed = [
    { name: 'REDIS_URL', site: { file: 'a.js', line: 1 } },
    { name: 'SMTP_HOST', site: { file: 'a.js', line: 2 } },
  ];
  const added = [
    { name: 'REDIS_URI', site: { file: 'b.js', line: 1 } },
    { name: 'WEBHOOK_SECRET', site: { file: 'b.js', line: 2 } },
  ];
  const got = detectRenames(removed, added);
  assert.equal(got.length, 1);
  assert.equal(got[0].from, 'REDIS_URL');
  assert.equal(got[0].to, 'REDIS_URI');
  assert.ok(got[0].score >= RENAME_THRESHOLD);
});

// --- image lists ------------------------------------------------------------

test('imageRepo strips tag and digest, keeps registry path', () => {
  assert.equal(imageRepo('node:20-alpine'), 'node');
  assert.equal(imageRepo('docker.io/library/golang:1.26-alpine3.23'), 'docker.io/library/golang');
  assert.equal(imageRepo('ghcr.io/org/app@sha256:abc'), 'ghcr.io/org/app');
  assert.equal(imageRepo('registry:5000/img:v1'), 'registry:5000/img');
});

test('diffImageLists: pairs same-repo bumps as changed, dedupes repeats', () => {
  // Old: one golang stage plus alpine. New: TWO golang stages (same image) plus alpine.
  const got = diffImageLists(
    ['docker.io/library/golang:1.25-alpine3.22', 'docker.io/library/alpine:3.22'],
    [
      'docker.io/library/golang:1.26-alpine3.23',
      'docker.io/library/golang:1.26-alpine3.23',
      'docker.io/library/alpine:3.23',
    ],
  );
  assert.deepEqual(got, {
    changed: [
      { from: 'docker.io/library/golang:1.25-alpine3.22', to: 'docker.io/library/golang:1.26-alpine3.23' },
      { from: 'docker.io/library/alpine:3.22', to: 'docker.io/library/alpine:3.23' },
    ],
    added: [],
    removed: [],
  });
});

test('diffImageLists: unrelated images are plain added/removed', () => {
  const got = diffImageLists(['debian:bookworm'], ['ubuntu:24.04']);
  assert.deepEqual(got, { changed: [], added: ['ubuntu:24.04'], removed: ['debian:bookworm'] });
});

// --- diffSurfaces -----------------------------------------------------------

test('diffSurfaces: env added, removed, renamed', () => {
  const a = envSurface([
    ['KEEP_ME', 'src/app.js', 1],
    ['OLD_ONLY', 'src/app.js', 2],
    ['REDIS_URL', 'src/redis.js', 3],
  ]);
  const b = envSurface([
    ['KEEP_ME', 'src/app.js', 1],
    ['BRAND_NEW', 'src/app.js', 5],
    ['REDIS_URI', 'src/redis.js', 3],
  ]);
  const d = diffSurfaces(a, b);
  assert.deepEqual(d.env.added.map((e) => e.name), ['BRAND_NEW']);
  assert.deepEqual(d.env.removed.map((e) => e.name), ['OLD_ONLY']);
  assert.equal(d.env.renamed.length, 1);
  assert.equal(d.env.renamed[0].from, 'REDIS_URL');
  assert.equal(d.env.renamed[0].to, 'REDIS_URI');
});

test('diffSurfaces: new migrations only', () => {
  const a = emptySurface();
  a.migrations.add('migrations/0001_init.sql');
  const b = emptySurface();
  b.migrations.add('migrations/0001_init.sql');
  b.migrations.add('migrations/0002_add_users.sql');
  const d = diffSurfaces(a, b);
  assert.deepEqual(d.migrations.added, ['migrations/0002_add_users.sql']);
});

test('diffSurfaces: base image change and EXPOSE diff', () => {
  const a = emptySurface();
  a.dockerfiles.set('Dockerfile', {
    from: [
      { image: 'golang:1.21', stage: 'builder', line: 1, isStageRef: false },
      { image: 'alpine:3.19', stage: null, line: 5, isStageRef: false },
    ],
    expose: [{ port: '8080', line: 8 }],
  });
  const b = emptySurface();
  b.dockerfiles.set('Dockerfile', {
    from: [
      { image: 'golang:1.22', stage: 'builder', line: 1, isStageRef: false },
      { image: 'alpine:3.20', stage: null, line: 5, isStageRef: false },
    ],
    expose: [
      { port: '8080', line: 8 },
      { port: '9090', line: 9 },
    ],
  });
  const d = diffSurfaces(a, b);
  assert.deepEqual(d.images, [
    {
      file: 'Dockerfile',
      changed: [
        { from: 'golang:1.21', to: 'golang:1.22' },
        { from: 'alpine:3.19', to: 'alpine:3.20' },
      ],
      added: [],
      removed: [],
    },
  ]);
  assert.deepEqual(d.ports.expose, [{ file: 'Dockerfile', added: ['9090'], removed: [] }]);
});

test('diffSurfaces: stage refs are ignored for base image diff', () => {
  const a = emptySurface();
  a.dockerfiles.set('Dockerfile', {
    from: [
      { image: 'node:20', stage: 'base', line: 1, isStageRef: false },
      { image: 'base', stage: 'deps', line: 2, isStageRef: true },
    ],
    expose: [],
  });
  const b = emptySurface();
  b.dockerfiles.set('Dockerfile', {
    from: [
      { image: 'node:22', stage: 'base', line: 1, isStageRef: false },
      { image: 'base', stage: 'deps', line: 2, isStageRef: true },
    ],
    expose: [],
  });
  const d = diffSurfaces(a, b);
  assert.deepEqual(d.images[0].changed, [{ from: 'node:20', to: 'node:22' }]);
});

test('diffSurfaces: compose port changes', () => {
  const a = emptySurface();
  a.composePorts.set('docker-compose.yml', ['8080:80']);
  const b = emptySurface();
  b.composePorts.set('docker-compose.yml', ['9090:80']);
  const d = diffSurfaces(a, b);
  assert.deepEqual(d.ports.compose, [
    { file: 'docker-compose.yml', added: ['9090:80'], removed: ['8080:80'] },
  ]);
});

test('diffSurfaces: listen port changes carry a site', () => {
  const a = emptySurface();
  a.listenPorts.set('3000', { file: 'server.js', line: 10 });
  const b = emptySurface();
  b.listenPorts.set('4000', { file: 'server.js', line: 10 });
  const d = diffSurfaces(a, b);
  assert.deepEqual(d.ports.listen.added, [{ port: '4000', file: 'server.js', line: 10 }]);
  assert.deepEqual(d.ports.listen.removed, [{ port: '3000', file: 'server.js', line: 10 }]);
});

test('isEmptyDiff: true for identical surfaces', () => {
  const a = envSurface([['X', 'a.js', 1]]);
  const b = envSurface([['X', 'a.js', 1]]);
  assert.ok(isEmptyDiff(diffSurfaces(a, b)));
});

// --- rendering --------------------------------------------------------------

test('renderText: empty diff message', () => {
  const d = diffSurfaces(emptySurface(), emptySurface());
  const out = renderText(d, 'v1', 'v2', { color: false });
  assert.match(out, /No deployment surface changes detected/);
});

test('renderText: sections appear and contain entries', () => {
  const a = envSurface([['OLD_VAR', 'a.js', 1]]);
  const b = envSurface([['NEW_VAR', 'b.js', 2]]);
  b.migrations.add('migrations/0002_x.sql');
  const d = diffSurfaces(a, b);
  const out = renderText(d, 'v1', 'v2', { color: false });
  assert.match(out, /ENV VARS/);
  assert.match(out, /\+ added {2}\s+NEW_VAR\s+b\.js:2/);
  assert.match(out, /- removed\s+OLD_VAR\s+was a\.js:1/);
  assert.match(out, /MIGRATIONS/);
  assert.match(out, /migrations\/0002_x\.sql/);
  assert.match(out, /Summary:/);
});

test('renderJson: stable machine-readable shape', () => {
  const a = envSurface([['REDIS_URL', 'r.js', 1]]);
  const b = envSurface([['REDIS_URI', 'r.js', 1]]);
  const d = diffSurfaces(a, b);
  const parsed = JSON.parse(renderJson(d, 'v1', 'v2'));
  assert.equal(parsed.tool, 'opdiff');
  assert.equal(parsed.from, 'v1');
  assert.equal(parsed.to, 'v2');
  assert.deepEqual(parsed.env.renamed[0].from, 'REDIS_URL');
  assert.deepEqual(parsed.env.renamed[0].to, 'REDIS_URI');
  assert.ok(parsed.env.renamed[0].score >= RENAME_THRESHOLD);
});
