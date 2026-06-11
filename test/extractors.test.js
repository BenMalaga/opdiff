import test from 'node:test';
import assert from 'node:assert/strict';
import {
  languageOf,
  isDockerfilePath,
  isComposePath,
  isMigrationPath,
  extractEnvVars,
  extractListenPorts,
  parseDockerfile,
  parseComposePorts,
} from '../src/extractors.js';

test('languageOf maps extensions', () => {
  assert.equal(languageOf('src/index.js'), 'js');
  assert.equal(languageOf('src/index.mjs'), 'js');
  assert.equal(languageOf('src/app.tsx'), 'js');
  assert.equal(languageOf('src/types.d.ts'), 'js');
  assert.equal(languageOf('app/main.py'), 'python');
  assert.equal(languageOf('cmd/serve.go'), 'go');
  assert.equal(languageOf('README.md'), null);
  assert.equal(languageOf('script.rb'), null);
});

test('isDockerfilePath conventions', () => {
  assert.ok(isDockerfilePath('Dockerfile'));
  assert.ok(isDockerfilePath('docker/Dockerfile.prod'));
  assert.ok(isDockerfilePath('build/api.dockerfile'));
  assert.ok(isDockerfilePath('Containerfile'));
  assert.ok(!isDockerfilePath('Dockerfile/readme.txt'));
  assert.ok(!isDockerfilePath('src/dockerfile.go'));
});

test('isComposePath conventions', () => {
  assert.ok(isComposePath('docker-compose.yml'));
  assert.ok(isComposePath('docker-compose.prod.yaml'));
  assert.ok(isComposePath('compose.yaml'));
  assert.ok(isComposePath('deploy/compose.override.yml'));
  assert.ok(!isComposePath('docker-compose.md'));
  assert.ok(!isComposePath('values.yaml'));
});

test('isMigrationPath conventions', () => {
  assert.ok(isMigrationPath('migrations/0001_init.sql'));
  assert.ok(isMigrationPath('db/migrate/20260101_add_users.rb'));
  assert.ok(isMigrationPath('alembic/versions/abc123_add_index.py'));
  assert.ok(isMigrationPath('prisma/migrations/20260101_init/migration.sql'));
  assert.ok(isMigrationPath('models/migrations/v2/v200.go'));
  assert.ok(!isMigrationPath('migrations/README.md'));
  assert.ok(!isMigrationPath('src/app.js'));
});

// --- env vars ---------------------------------------------------------------

test('extractEnvVars: JS dot and bracket access', () => {
  const src = [
    'const url = process.env.DATABASE_URL;',
    'const key = process.env["API_KEY"];',
    "const tok = process.env['AUTH_TOKEN'];",
    'const dyn = process.env[someVar];', // dynamic: not extracted
    'const tmpl = process.env[`CACHE_TTL`];',
  ].join('\n');
  const got = extractEnvVars(src, 'js');
  assert.deepEqual(got, [
    { name: 'DATABASE_URL', line: 1 },
    { name: 'API_KEY', line: 2 },
    { name: 'AUTH_TOKEN', line: 3 },
    { name: 'CACHE_TTL', line: 5 },
  ]);
});

test('extractEnvVars: Python environ, get, getenv', () => {
  const src = [
    'import os',
    'from os import environ, getenv',
    'a = os.environ["SECRET_KEY"]',
    'b = os.environ.get("DEBUG", "0")',
    "c = os.getenv('REDIS_URL')",
    'd = environ["SMTP_HOST"]',
    'e = environ.get("SMTP_PORT")',
    'f = getenv("LOG_LEVEL", "info")',
    'g = myenviron["NOT_THIS"]', // not os.environ
  ].join('\n');
  const names = extractEnvVars(src, 'python').map((e) => e.name);
  assert.deepEqual(names, ['SECRET_KEY', 'DEBUG', 'REDIS_URL', 'SMTP_HOST', 'SMTP_PORT', 'LOG_LEVEL']);
});

test('extractEnvVars: Go Getenv and LookupEnv', () => {
  const src = [
    'package main',
    'var dsn = os.Getenv("GITEA_DB_DSN")',
    'if v, ok := os.LookupEnv("GITEA_WORK_DIR"); ok {',
    '}',
  ].join('\n');
  const got = extractEnvVars(src, 'go');
  assert.deepEqual(got, [
    { name: 'GITEA_DB_DSN', line: 2 },
    { name: 'GITEA_WORK_DIR', line: 3 },
  ]);
});

test('extractEnvVars: dedupes same name on same line, keeps distinct lines', () => {
  const src = 'const a = process.env.X || process.env.X;\nconst b = process.env.X;';
  const got = extractEnvVars(src, 'js');
  assert.deepEqual(got, [
    { name: 'X', line: 1 },
    { name: 'X', line: 2 },
  ]);
});

test('extractEnvVars: unknown language returns empty', () => {
  assert.deepEqual(extractEnvVars('os.Getenv("X")', 'rust'), []);
});

// --- listen ports -----------------------------------------------------------

test('extractListenPorts: JS listen call and PORT default', () => {
  const src = ['app.listen(3000);', 'const port = process.env.PORT || 8080;'].join('\n');
  const got = extractListenPorts(src, 'js');
  assert.deepEqual(got, [
    { port: '3000', line: 1 },
    { port: '8080', line: 2 },
  ]);
});

test('extractListenPorts: Python run(port=) and getenv default', () => {
  const src = ['app.run(host="0.0.0.0", port=5000)', 'p = int(os.getenv("PORT", "8000"))'].join('\n');
  const got = extractListenPorts(src, 'python');
  assert.deepEqual(got, [
    { port: '5000', line: 1 },
    { port: '8000', line: 2 },
  ]);
});

test('extractListenPorts: Go ListenAndServe and Server Addr', () => {
  const src = [
    'http.ListenAndServe(":8080", nil)',
    'srv := &http.Server{Addr: "0.0.0.0:9090"}',
  ].join('\n');
  const got = extractListenPorts(src, 'go');
  assert.deepEqual(got, [
    { port: '8080', line: 1 },
    { port: '9090', line: 2 },
  ]);
});

// --- Dockerfile -------------------------------------------------------------

test('parseDockerfile: FROM, multi-stage, platform flag, EXPOSE', () => {
  const src = [
    'FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS builder',
    'RUN go build -o app .',
    'FROM alpine:3.20',
    'COPY --from=builder /app /app',
    'EXPOSE 8080 9090/udp',
    'EXPOSE 3000 # metrics',
  ].join('\n');
  const got = parseDockerfile(src);
  assert.deepEqual(
    got.from.map((f) => [f.image, f.stage, f.isStageRef]),
    [
      ['golang:1.22-alpine', 'builder', false],
      ['alpine:3.20', null, false],
    ],
  );
  assert.deepEqual(
    got.expose.map((e) => e.port),
    ['8080', '9090/udp', '3000'],
  );
});

test('parseDockerfile: FROM referencing earlier stage is flagged as stage ref', () => {
  const src = ['FROM node:20 AS base', 'FROM base AS deps', 'FROM deps'].join('\n');
  const got = parseDockerfile(src);
  assert.deepEqual(
    got.from.map((f) => [f.image, f.isStageRef]),
    [
      ['node:20', false],
      ['base', true],
      ['deps', true],
    ],
  );
});

// --- compose ----------------------------------------------------------------

test('parseComposePorts: block list with quotes and comments', () => {
  const src = [
    'services:',
    '  web:',
    '    image: nginx',
    '    ports:',
    '      - "8080:80"',
    "      - '443:443'",
    '      - 9090:9090 # metrics',
    '    environment:',
    '      - FOO=bar',
    '  db:',
    '    ports:',
    '      - 5432:5432',
  ].join('\n');
  assert.deepEqual(parseComposePorts(src), ['8080:80', '443:443', '9090:9090', '5432:5432']);
});

test('parseComposePorts: inline list', () => {
  const src = 'services:\n  web:\n    ports: ["80:80", 8443:8443]\n';
  assert.deepEqual(parseComposePorts(src), ['80:80', '8443:8443']);
});

test('parseComposePorts: long syntax target/published', () => {
  const src = [
    'services:',
    '  web:',
    '    ports:',
    '      - target: 80',
    '        published: 8080',
    '      - target: 443',
    '        published: 8443',
    '    image: nginx',
  ].join('\n');
  assert.deepEqual(parseComposePorts(src), ['8080:80', '8443:443']);
});
