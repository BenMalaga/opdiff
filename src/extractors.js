// Pure extractors: take a source string (or path), return structured facts.
// No git, no fs, no network. Everything here is unit-testable in isolation.

const JS_EXT = /\.(?:[cm]?jsx?|[cm]?tsx?)$/;
const PY_EXT = /\.pyi?$/;
const GO_EXT = /\.go$/;

/** Map a file path to a supported language id, or null. */
export function languageOf(path) {
  if (JS_EXT.test(path)) return 'js';
  if (PY_EXT.test(path)) return 'python';
  if (GO_EXT.test(path)) return 'go';
  return null;
}

/** Dockerfile detection by file name conventions. */
export function isDockerfilePath(path) {
  const base = path.split('/').pop();
  return (
    base === 'Dockerfile' ||
    base === 'Containerfile' ||
    base.startsWith('Dockerfile.') ||
    /\.dockerfile$/i.test(base)
  );
}

/** docker-compose / compose file detection by file name conventions. */
export function isComposePath(path) {
  const base = path.split('/').pop();
  return /^(docker-)?compose[^/]*\.ya?ml$/i.test(base);
}

/** Common migration directory conventions (Rails, Django, Alembic, Prisma, Knex, golang-migrate, ...). */
const MIGRATION_DIR = /(^|\/)(migrations?|migrate|alembic)\//i;

export function isMigrationPath(path) {
  if (!MIGRATION_DIR.test(path)) return false;
  // Documentation inside migration dirs is not a migration.
  if (/\.(md|markdown|txt)$/i.test(path)) return false;
  return true;
}

// --- Env var read sites -----------------------------------------------------

const ENV_PATTERNS = {
  js: [
    // process.env.FOO
    /process\.env\.([A-Za-z_$][A-Za-z0-9_$]*)/g,
    // process.env["FOO"], process.env['FOO'], process.env[`FOO`]
    /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
  ],
  python: [
    // os.environ["FOO"] / environ["FOO"]
    /(?<![\w.])(?:os\.)?environ\[\s*["']([^"']+)["']\s*\]/g,
    // os.environ.get("FOO", ...) / environ.get("FOO")
    /(?<![\w.])(?:os\.)?environ\.get\(\s*["']([^"']+)["']/g,
    // os.getenv("FOO", ...)
    /os\.getenv\(\s*["']([^"']+)["']/g,
    // bare getenv("FOO") via `from os import getenv`
    /(?<![\w.])getenv\(\s*["']([^"']+)["']/g,
  ],
  go: [
    // os.Getenv("FOO")
    /os\.Getenv\(\s*"([^"]+)"\s*\)/g,
    // os.LookupEnv("FOO")
    /os\.LookupEnv\(\s*"([^"]+)"\s*\)/g,
  ],
};

/**
 * Extract env var read sites from source code.
 * @returns {Array<{name: string, line: number}>}
 */
export function extractEnvVars(source, lang) {
  const patterns = ENV_PATTERNS[lang];
  if (!patterns) return [];
  const out = [];
  const seen = new Set();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        const name = m[1];
        const key = name + '\n' + (i + 1);
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ name, line: i + 1 });
        }
      }
    }
  }
  return out;
}

// --- Listen ports -----------------------------------------------------------

const PORT_PATTERNS = {
  js: [
    // app.listen(3000), server.listen(8080, ...)
    /\.listen\(\s*(\d{2,5})\b/g,
    // process.env.PORT || 3000, process.env.PORT ?? 3000
    /process\.env\.PORT\s*(?:\|\||\?\?)\s*['"`]?(\d{2,5})\b/g,
  ],
  python: [
    // app.run(port=5000), uvicorn.run(..., port=8000)
    /\.run\([^)\n]*\bport\s*=\s*(\d{2,5})\b/g,
    // os.getenv("PORT", "8000") and friends
    /(?:os\.)?getenv\(\s*["']PORT["']\s*,\s*["']?(\d{2,5})\b/g,
    /(?:os\.)?environ\.get\(\s*["']PORT["']\s*,\s*["']?(\d{2,5})\b/g,
  ],
  go: [
    // http.ListenAndServe(":8080", ...)
    /ListenAndServe(?:TLS)?\(\s*"[^"]*:(\d{2,5})"/g,
    // &http.Server{Addr: ":8080"}
    /\bAddr:\s*"[^"]*:(\d{2,5})"/g,
  ],
};

/**
 * Extract likely listen-port literals from source code.
 * @returns {Array<{port: string, line: number}>}
 */
export function extractListenPorts(source, lang) {
  const patterns = PORT_PATTERNS[lang];
  if (!patterns) return [];
  const out = [];
  const seen = new Set();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        const key = m[1] + '\n' + (i + 1);
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ port: m[1], line: i + 1 });
        }
      }
    }
  }
  return out;
}

// --- Dockerfile -------------------------------------------------------------

/**
 * Parse FROM and EXPOSE lines out of a Dockerfile.
 * Multi-stage aware: FROM lines that reference a previously declared stage
 * are marked isStageRef so they are not reported as base images.
 * @returns {{from: Array<{image, stage, line, isStageRef}>, expose: Array<{port, line}>}}
 */
export function parseDockerfile(source) {
  const from = [];
  const expose = [];
  const stages = new Set();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+as\s+(\S+))?\s*(?:#.*)?$/i.exec(line);
    if (m) {
      const image = m[1];
      const stage = m[2] || null;
      const isStageRef = stages.has(image.toLowerCase());
      if (stage) stages.add(stage.toLowerCase());
      from.push({ image, stage, line: i + 1, isStageRef });
      continue;
    }
    m = /^\s*EXPOSE\s+(.+)$/i.exec(line);
    if (m) {
      for (const tok of m[1].trim().split(/\s+/)) {
        if (tok.startsWith('#')) break;
        expose.push({ port: tok, line: i + 1 });
      }
    }
  }
  return { from, expose };
}

// --- docker-compose ---------------------------------------------------------

function cleanComposeItem(s) {
  const v = s
    .trim()
    .replace(/\s+#.*$/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
  return v || null;
}

/**
 * Extract `ports:` entries from a compose file.
 * Handles block lists, inline lists, and long-syntax (target/published) entries
 * without a YAML dependency.
 * @returns {string[]} port mapping strings, e.g. "8080:80"
 */
export function parseComposePorts(source) {
  const ports = [];
  let inPorts = false;
  let portsIndent = 0;
  let pendingTarget = null;
  let pendingPublished = null;

  const flushLong = () => {
    if (pendingTarget !== null || pendingPublished !== null) {
      if (pendingPublished !== null && pendingTarget !== null) {
        ports.push(`${pendingPublished}:${pendingTarget}`);
      } else {
        ports.push(String(pendingPublished ?? pendingTarget));
      }
      pendingTarget = null;
      pendingPublished = null;
    }
  };

  for (const raw of source.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    const inline = /^\s*ports:\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      for (const item of inline[1].split(',')) {
        const v = cleanComposeItem(item);
        if (v) ports.push(v);
      }
      continue;
    }

    const open = /^\s*ports:\s*$/.exec(line);
    if (open) {
      flushLong();
      inPorts = true;
      portsIndent = indent;
      continue;
    }

    if (!inPorts) continue;
    if (indent <= portsIndent) {
      flushLong();
      inPorts = false;
      continue;
    }

    const dash = /^\s*-\s*(.*)$/.exec(line);
    if (dash) {
      flushLong();
      const rest = dash[1].trim();
      const kv = /^(target|published):\s*["']?(\d+)["']?/.exec(rest);
      if (kv) {
        if (kv[1] === 'target') pendingTarget = kv[2];
        else pendingPublished = kv[2];
      } else {
        const v = cleanComposeItem(rest);
        if (v) ports.push(v);
      }
    } else {
      const kv = /^\s*(target|published):\s*["']?(\d+)["']?/.exec(line);
      if (kv) {
        if (kv[1] === 'target') pendingTarget = kv[2];
        else pendingPublished = kv[2];
      }
    }
  }
  flushLong();
  return ports;
}
