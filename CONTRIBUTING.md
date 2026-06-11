# Contributing to opdiff

Thanks for considering a contribution. The project is intentionally small and
should stay that way: zero runtime dependencies, deterministic output, no
network access, no LLMs.

## Setup

```console
git clone https://github.com/BenMalaga/opdiff
cd opdiff
node --test
```

That is everything. There is no build step and nothing to install.

## Project layout

```
bin/opdiff.js       executable entry point
src/cli.js          argument parsing and orchestration
src/gitio.js        git plumbing (ls-tree, cat-file --batch), no checkout
src/extractors.js   pure functions: source string in, facts out
src/diff.js         surface collection, rename detection, ref-to-ref diff
src/report.js       text and JSON rendering
test/               node:test suites, including an end-to-end fixture repo
```

## Adding a detector or a language

Most contributions land in `src/extractors.js`:

1. Add a regex pattern set (see `ENV_PATTERNS` for the shape). Patterns run per
   line, so matches get a line number for free.
2. Wire the file extension in `languageOf` if it is a new language.
3. Add unit tests in `test/extractors.test.js` with realistic snippets,
   including at least one case that must NOT match.
4. If the change affects diffing or rendering, extend `test/diff.test.js` and
   the end-to-end fixture in `test/integration.test.js`.

Before opening a PR, please run the tool against a real repository you know and
sanity-check the output. False positives are worse than misses here: an
operator who gets paged for a phantom env var stops trusting the tool.

## Ground rules

- Zero runtime dependencies. If a feature needs a YAML parser, it needs a
  hand-rolled minimal one or a different design.
- Output must be deterministic: same repo, same refs, same bytes.
- Node 18 or newer, ESM only.
- New behavior ships with tests. `node --test` must pass.

## Reporting bugs

Open an issue with the repository (if public), the two refs, and the incorrect
or missing line of output. A failing test case is even better.
