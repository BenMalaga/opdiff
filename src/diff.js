// Surface collection and ref-to-ref diff logic.

import {
  languageOf,
  isDockerfilePath,
  isComposePath,
  isMigrationPath,
  extractEnvVars,
  extractListenPorts,
  parseDockerfile,
  parseComposePorts,
} from './extractors.js';
import { listTree, readFilesAtRef } from './gitio.js';

const SKIP_DIRS =
  /(^|\/)(node_modules|vendor|vendors|third_party|thirdparty|dist|build|out|coverage|\.git|\.next|\.nuxt|target|__pycache__|\.venv|venv|bower_components)(\/|$)/;

const TEST_PATH =
  /(^|\/)(test|tests|__tests__|testdata|testutils|e2e|spec|specs|fixtures|__mocks__|mocks)(\/|$)|_test\.go$|_test\.py$|(^|\/)test_[^/]*\.py$|\.(test|spec)\.[cm]?[jt]sx?$/;

const MINIFIED = /\.min\.(js|css)$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Collect the deployment surface of a repository at a given ref.
 * Reads blobs via git plumbing only; never touches the working tree.
 */
export function collectSurface(ref, cwd, opts = {}) {
  const entries = listTree(ref, cwd);
  const kept = entries
    .map((e) => e.path)
    .filter((p) => !SKIP_DIRS.test(p) && !MINIFIED.test(p))
    .filter((p) => opts.includeTests || !TEST_PATH.test(p));

  const surface = {
    env: new Map(), // name -> { sites: [{file, line}] }
    migrations: new Set(), // paths
    dockerfiles: new Map(), // path -> { from, expose }
    composePorts: new Map(), // path -> [port strings]
    listenPorts: new Map(), // port -> { file, line }
  };

  for (const p of kept) {
    if (isMigrationPath(p)) surface.migrations.add(p);
  }

  const want = kept.filter((p) => languageOf(p) || isDockerfilePath(p) || isComposePath(p));
  const files = readFilesAtRef(ref, want, cwd);

  for (const [path, src] of files) {
    if (src.length > MAX_FILE_BYTES || src.includes('\0')) continue;
    const lang = languageOf(path);
    if (lang) {
      for (const { name, line } of extractEnvVars(src, lang)) {
        const cur = surface.env.get(name);
        if (!cur) surface.env.set(name, { sites: [{ file: path, line }] });
        else if (cur.sites.length < 5) cur.sites.push({ file: path, line });
      }
      for (const { port, line } of extractListenPorts(src, lang)) {
        if (!surface.listenPorts.has(port)) surface.listenPorts.set(port, { file: path, line });
      }
    }
    if (isDockerfilePath(path)) surface.dockerfiles.set(path, parseDockerfile(src));
    if (isComposePath(path)) {
      const ports = parseComposePorts(src);
      if (ports.length) surface.composePorts.set(path, ports);
      else surface.composePorts.set(path, []);
    }
  }

  return surface;
}

// --- Rename detection -------------------------------------------------------

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * Name similarity in [0, 1]: blend of normalized edit distance and
 * underscore-token overlap. REDIS_URL vs REDIS_URI scores ~0.73;
 * SMTP_HOST vs REDIS_PORT scores ~0.1.
 */
export function similarity(a, b) {
  if (a === b) return 1;
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  const lev = 1 - levenshtein(A, B) / Math.max(A.length, B.length);
  const ta = new Set(A.split(/[_\-.]/).filter(Boolean));
  const tb = new Set(B.split(/[_\-.]/).filter(Boolean));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const denom = Math.max(ta.size, tb.size);
  const tok = denom ? shared / denom : 0;
  return Math.round((0.6 * lev + 0.4 * tok) * 100) / 100;
}

export const RENAME_THRESHOLD = 0.6;

/**
 * Pair removed env vars with added ones when names are similar enough.
 * Greedy best-score matching; each name is used at most once.
 */
export function detectRenames(removed, added) {
  const candidates = [];
  for (const r of removed) {
    for (const a of added) {
      const score = similarity(r.name, a.name);
      if (score >= RENAME_THRESHOLD) candidates.push({ r, a, score });
    }
  }
  candidates.sort(
    (x, y) => y.score - x.score || x.r.name.localeCompare(y.r.name) || x.a.name.localeCompare(y.a.name),
  );
  const usedFrom = new Set();
  const usedTo = new Set();
  const renames = [];
  for (const c of candidates) {
    if (usedFrom.has(c.r.name) || usedTo.has(c.a.name)) continue;
    usedFrom.add(c.r.name);
    usedTo.add(c.a.name);
    renames.push({
      from: c.r.name,
      to: c.a.name,
      score: c.score,
      fromSite: c.r.site,
      toSite: c.a.site,
    });
  }
  renames.sort((x, y) => x.from.localeCompare(y.from));
  return renames;
}

// --- Diff -------------------------------------------------------------------

const byName = (x, y) => x.name.localeCompare(y.name);

/** Repository part of an image reference (tag and digest stripped). */
export function imageRepo(image) {
  const noDigest = image.split('@')[0];
  const lastColon = noDigest.lastIndexOf(':');
  const lastSlash = noDigest.lastIndexOf('/');
  return lastColon > lastSlash ? noDigest.slice(0, lastColon) : noDigest;
}

/**
 * Diff two base-image lists. Images sharing a repository (e.g. golang:1.25
 * vs golang:1.26) are paired as "changed"; the rest are added/removed.
 */
export function diffImageLists(fa, fb) {
  const ua = [...new Set(fa)];
  const ub = [...new Set(fb)];
  const removed0 = ua.filter((x) => !ub.includes(x));
  const added0 = ub.filter((x) => !ua.includes(x));
  const changed = [];
  const added = [];
  const pairedRemoved = new Set();
  for (const img of added0) {
    const repo = imageRepo(img);
    const match = removed0.find((r) => !pairedRemoved.has(r) && imageRepo(r) === repo);
    if (match) {
      pairedRemoved.add(match);
      changed.push({ from: match, to: img });
    } else {
      added.push(img);
    }
  }
  const removed = removed0.filter((r) => !pairedRemoved.has(r));
  return { changed, added, removed };
}

function firstSite(info) {
  return info.sites[0];
}

/**
 * Diff two surfaces (A = old ref, B = new ref).
 */
export function diffSurfaces(a, b) {
  // Env vars
  const addedRaw = [];
  const removedRaw = [];
  for (const [name, info] of b.env) {
    if (!a.env.has(name)) addedRaw.push({ name, site: firstSite(info) });
  }
  for (const [name, info] of a.env) {
    if (!b.env.has(name)) removedRaw.push({ name, site: firstSite(info) });
  }
  addedRaw.sort(byName);
  removedRaw.sort(byName);
  const renamed = detectRenames(removedRaw, addedRaw);
  const renamedFrom = new Set(renamed.map((r) => r.from));
  const renamedTo = new Set(renamed.map((r) => r.to));
  const env = {
    added: addedRaw.filter((x) => !renamedTo.has(x.name)),
    removed: removedRaw.filter((x) => !renamedFrom.has(x.name)),
    renamed,
  };

  // Migrations
  const migrations = {
    added: [...b.migrations].filter((p) => !a.migrations.has(p)).sort(),
  };

  // Dockerfiles: base images and EXPOSE
  const dockerfilePaths = [...new Set([...a.dockerfiles.keys(), ...b.dockerfiles.keys()])].sort();
  const images = [];
  const expose = [];
  for (const f of dockerfilePaths) {
    const da = a.dockerfiles.get(f);
    const db = b.dockerfiles.get(f);
    const fa = (da ? da.from : []).filter((x) => !x.isStageRef).map((x) => x.image);
    const fb = (db ? db.from : []).filter((x) => !x.isStageRef).map((x) => x.image);
    if (JSON.stringify(fa) !== JSON.stringify(fb)) {
      const { changed, added, removed } = diffImageLists(fa, fb);
      if (changed.length || added.length || removed.length) {
        images.push({ file: f, changed, added, removed });
      }
    }
    const ea = (da ? da.expose : []).map((x) => x.port);
    const eb = (db ? db.expose : []).map((x) => x.port);
    const addE = eb.filter((p) => !ea.includes(p));
    const remE = ea.filter((p) => !eb.includes(p));
    if (addE.length || remE.length) expose.push({ file: f, added: addE, removed: remE });
  }

  // Compose ports
  const composeFiles = [...new Set([...a.composePorts.keys(), ...b.composePorts.keys()])].sort();
  const compose = [];
  for (const f of composeFiles) {
    const pa = a.composePorts.get(f) || [];
    const pb = b.composePorts.get(f) || [];
    const addP = pb.filter((p) => !pa.includes(p));
    const remP = pa.filter((p) => !pb.includes(p));
    if (addP.length || remP.length) compose.push({ file: f, added: addP, removed: remP });
  }

  // Listen ports
  const listen = { added: [], removed: [] };
  for (const [port, site] of b.listenPorts) {
    if (!a.listenPorts.has(port)) listen.added.push({ port, ...site });
  }
  for (const [port, site] of a.listenPorts) {
    if (!b.listenPorts.has(port)) listen.removed.push({ port, ...site });
  }
  listen.added.sort((x, y) => x.port.localeCompare(y.port, undefined, { numeric: true }));
  listen.removed.sort((x, y) => x.port.localeCompare(y.port, undefined, { numeric: true }));

  return { env, migrations, ports: { expose, compose, listen }, images };
}

/** True when a diff contains nothing operator-relevant. */
export function isEmptyDiff(d) {
  return (
    d.env.added.length === 0 &&
    d.env.removed.length === 0 &&
    d.env.renamed.length === 0 &&
    d.migrations.added.length === 0 &&
    d.ports.expose.length === 0 &&
    d.ports.compose.length === 0 &&
    d.ports.listen.added.length === 0 &&
    d.ports.listen.removed.length === 0 &&
    d.images.length === 0
  );
}
