<div align="center">

# opdiff

**Changelogs are written by humans. The code cannot lie.**

Operator-facing upgrade notes derived from the code itself: diff the deployment
surface (env vars, ports, migrations, base images) between two git refs.

[![release](https://img.shields.io/github/v/release/BenMalaga/opdiff)](https://github.com/BenMalaga/opdiff/releases)
[![CI](https://github.com/BenMalaga/opdiff/actions/workflows/test.yml/badge.svg)](https://github.com/BenMalaga/opdiff/actions/workflows/test.yml)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

You run software that other people wrote. A new release lands. The changelog says
"various improvements and bug fixes". What it does not say: a config env var was
renamed, there are eight new database migrations, and the base image jumped a major
version. You find out at 2am.

`opdiff` answers the only question an operator actually has before an upgrade:
**what changed about how I run this thing?** It reads the source at both refs
straight from git (no checkout, no build, no network, no LLM) and prints a
deterministic checklist.

## Real-world demo

This is `opdiff` running cold on [Gitea](https://github.com/go-gitea/gitea),
between the last two minor releases. Not a mockup, this is the verbatim output:

```console
$ opdiff v1.25.0..v1.26.0

ENV VARS
  + added   GITEA_TEST_E2E         modules/setting/setting.go:63
  + added   GITEA_TEST_ROOT        modules/setting/testenv.go:28
  + added   GOFUMPT_PACKAGE        tools/code-batch-process.go:264
  - removed GITEA_TEST_SLOW_FLUSH  was modules/testlogger/testlogger.go:176
  - removed GITEA_TEST_SLOW_RUN    was modules/testlogger/testlogger.go:171
  - removed TEST                   was web_src/js/utils/testhelper.ts:5
  ~ renamed? GITEA_CONF -> GITEA_TEST_CONF  (similarity 0.67) modules/setting/testenv.go:44
  ~ renamed? GITEA_UNIT_TESTS_LOG_SQL -> GITEA_TEST_LOG_SQL  (similarity 0.69) models/unittest/testdb.go:181

MIGRATIONS
  + models/migrations/v1_26/v323.go
  + models/migrations/v1_26/v324.go
  + models/migrations/v1_26/v325.go
  + models/migrations/v1_26/v326.go
  + models/migrations/v1_26/v327.go
  + models/migrations/v1_26/v328.go
  + models/migrations/v1_26/v329.go
  + models/migrations/v1_26/v330.go
  8 new migration file(s). Plan a migration step (and a backup) before rollout.

BASE IMAGES
  Dockerfile  docker.io/library/golang:1.25-alpine3.22 -> docker.io/library/golang:1.26-alpine3.23
  Dockerfile  docker.io/library/alpine:3.22 -> docker.io/library/alpine:3.23
  Dockerfile.rootless  docker.io/library/golang:1.25-alpine3.22 -> docker.io/library/golang:1.26-alpine3.23
  Dockerfile.rootless  docker.io/library/alpine:3.22 -> docker.io/library/alpine:3.23

Summary: 3 env added, 3 env removed, 2 possible rename(s), 8 new migration(s), base image change in 2 Dockerfile(s).
```

Every line above checks out against the Gitea source. The two flagged renames are
real: Gitea 1.26 genuinely renamed `GITEA_CONF` to `GITEA_TEST_CONF` and
`GITEA_UNIT_TESTS_LOG_SQL` to `GITEA_TEST_LOG_SQL`. The eight migration files
(v323 through v330) mean a schema upgrade runs on first boot, so take that backup.
None of this is in a human-written summary anywhere; it came out of the diff.

## Install

No install needed:

```console
npx opdiff v1.4.0..v2.0.0
```

Or globally:

```console
npm install -g opdiff
```

Zero dependencies, Node 18 or newer, and `git` on your PATH. That is the entire
supply chain.

## Usage

Run it inside any git repo. Both refs must exist locally (a shallow clone with
two tags fetched is enough):

```console
opdiff <ref1>..<ref2>           # range syntax
opdiff v1.4.0 v2.0.0            # or two args
opdiff v1.4.0..v2.0.0 --json    # machine-readable, for CI
opdiff HEAD~50 HEAD -C ~/src/x  # any refs, any repo
```

Options:

| Flag | Effect |
| --- | --- |
| `--json` | structured output for scripts and CI |
| `-C <dir>` | run against a repo in another directory |
| `--include-tests` | also scan test files (skipped by default) |
| `--no-color` | disable ANSI colors (also respects `NO_COLOR`) |

Exit code 0 on success, 2 on usage or ref errors.

## How it works

`opdiff` never checks anything out. It lists both trees with `git ls-tree -r`
and reads every relevant blob through a single `git cat-file --batch` round trip
per ref, then runs pure-function extractors over the source text:

1. **Env vars (the core feature).** Per-language read-site patterns:
   `process.env.X` and `process.env["X"]` in JS/TS, `os.environ["X"]`,
   `os.environ.get("X")` and `os.getenv("X")` in Python, `os.Getenv("X")` and
   `os.LookupEnv("X")` in Go. Vars are diffed by name across refs, each reported
   with a `file:line` read site. Removed/added pairs with high name similarity
   (edit distance blended with token overlap) are flagged as **likely renames**,
   the single most painful upgrade surprise.
2. **Migrations.** New files between refs under common migration directories
   (`migrations/`, `db/migrate/`, `alembic/`, `prisma/migrations/`, and friends).
3. **Ports.** Changed `EXPOSE` lines in Dockerfiles, changed `ports:` entries in
   compose files (block, inline, and long target/published syntax), and common
   listen-port literals (`app.listen(3000)`, `port=8000`, `ListenAndServe(":8080")`).
4. **Base images.** Changed `FROM` lines in Dockerfiles, multi-stage aware
   (references to earlier build stages are not reported as base images), with
   same-repository bumps paired as `old -> new`.

Vendored and generated trees (`node_modules/`, `vendor/`, `dist/`, ...) and test
files are skipped by default. Output ordering is fully deterministic: same repo,
same refs, same bytes out.

## How it compares

| Tool | What it diffs | What it misses for operators |
| --- | --- | --- |
| **opdiff** | env vars, migrations, ports, base images between two git refs | API schemas (by design, see below) |
| [oasdiff](https://github.com/oasdiff/oasdiff) | OpenAPI schemas | only the API surface; nothing about running the service |
| [dotenv-diff](https://www.npmjs.com/package/dotenv-diff) | current code vs current `.env` files | no ref-to-ref history; cannot answer "what changed between v1 and v2" |
| PatchPanda and similar | LLM summaries of release notes | inherits whatever the changelog forgot; non-deterministic |
| [container-diff](https://github.com/GoogleContainerTools/container-diff) | built image metadata (archived) | requires built images; sees packages, not config contracts |

The niche is specific: the contract between a release and the person deploying
it, recovered from source, with zero trust in prose.

## For maintainers: generate operator notes in CI

The same tool works from the publishing side. Add a step to your release
workflow and ship an "Upgrade notes for operators" section nobody had to write:

```yaml
- name: Operator upgrade notes
  run: |
    PREV=$(git describe --tags --abbrev=0 "${{ github.ref_name }}^")
    echo '## Upgrade notes for operators' >> notes.md
    echo '```' >> notes.md
    npx opdiff "$PREV..${{ github.ref_name }}" --no-color >> notes.md
    echo '```' >> notes.md
    gh release edit "${{ github.ref_name }}" --notes-file notes.md
```

The `--json` mode also lets you fail a release pipeline when, say, an env var
disappears without a deprecation note.

## Scope and roadmap

Deliberately small now, in roughly this order next:

- Helm `values.yaml` key changes
- CLI flag changes (argparse, cobra, commander registration sites)
- More env read patterns: Ruby `ENV[]`, Rust `std::env::var`, Java `System.getenv`
- Volume mount changes in Dockerfiles and compose files
- `--fail-on` for CI gating (e.g. fail when env vars are removed)

Not in scope: anything that needs a build, a network call, or a model. The
output must stay reproducible byte for byte.

## Contributing

The extractors are pure functions over source strings, which makes adding a
language or detector a small, well-tested change. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE), Ben Malaga.
