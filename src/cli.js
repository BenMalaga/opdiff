// CLI argument parsing and orchestration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isGitRepo, resolveRef } from './gitio.js';
import { collectSurface, diffSurfaces } from './diff.js';
import { renderText, renderJson } from './report.js';

const HELP = `opdiff: operator-facing upgrade notes derived from the code itself.

Usage:
  opdiff <ref1>..<ref2> [options]
  opdiff <ref1> <ref2>  [options]

Diffs the deployment surface (env vars, migrations, ports, base images)
between two git refs of the current repository. No checkout needed.

Options:
  --json           machine-readable output
  -C <dir>         run as if started in <dir>
  --include-tests  also scan test files (skipped by default)
  --no-color       disable ANSI colors
  -h, --help       show this help
  -v, --version    show version

Examples:
  opdiff v1.4.0..v2.0.0
  opdiff v1.4.0 v2.0.0 --json
  opdiff HEAD~20 HEAD -C ~/src/myapp
`;

function version() {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
  );
  return pkg.version;
}

export function parseArgs(argv) {
  const opts = { json: false, cwd: process.cwd(), includeTests: false, color: null, refs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--include-tests') opts.includeTests = true;
    else if (a === '--no-color') opts.color = false;
    else if (a === '--color') opts.color = true;
    else if (a === '-C') {
      opts.cwd = argv[++i];
      if (!opts.cwd) throw new UsageError('-C requires a directory argument');
    } else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a.startsWith('-')) throw new UsageError(`unknown option: ${a}`);
    else opts.refs.push(a);
  }

  // Expand "ref1..ref2" / "ref1...ref2" forms. Refs themselves may contain
  // single dots (v1.4.0), so split on the first run of 2+ dots.
  if (opts.refs.length === 1) {
    const m = /^(.+?)\.{2,3}(.+)$/.exec(opts.refs[0]);
    if (m) opts.refs = [m[1], m[2]];
  }
  return opts;
}

export class UsageError extends Error {}

export function run(argv, stdout = process.stdout, stderr = process.stderr) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      stderr.write(`opdiff: ${e.message}\n\n${HELP}`);
      return 2;
    }
    throw e;
  }

  if (opts.help) {
    stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    stdout.write(version() + '\n');
    return 0;
  }
  if (opts.refs.length !== 2) {
    stderr.write(`opdiff: expected two refs, got ${opts.refs.length}\n\n${HELP}`);
    return 2;
  }

  const [ref1, ref2] = opts.refs;
  if (!isGitRepo(opts.cwd)) {
    stderr.write(`opdiff: not a git repository: ${opts.cwd}\n`);
    return 2;
  }
  for (const ref of [ref1, ref2]) {
    if (!resolveRef(ref, opts.cwd)) {
      stderr.write(`opdiff: cannot resolve ref '${ref}' (is it fetched?)\n`);
      return 2;
    }
  }

  const surfaceA = collectSurface(ref1, opts.cwd, { includeTests: opts.includeTests });
  const surfaceB = collectSurface(ref2, opts.cwd, { includeTests: opts.includeTests });
  const diff = diffSurfaces(surfaceA, surfaceB);

  if (opts.json) {
    stdout.write(renderJson(diff, ref1, ref2) + '\n');
  } else {
    const color =
      opts.color !== null ? opts.color : Boolean(stdout.isTTY) && !process.env.NO_COLOR;
    stdout.write(renderText(diff, ref1, ref2, { color }) + '\n');
  }
  return 0;
}
