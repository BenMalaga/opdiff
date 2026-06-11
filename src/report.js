// Terminal and JSON rendering of a surface diff.

import { isEmptyDiff } from './diff.js';

function colorize(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    green: wrap('32'),
    red: wrap('31'),
    yellow: wrap('33'),
    cyan: wrap('36'),
  };
}

function site(s) {
  return s ? `${s.file}:${s.line}` : '';
}

const MAX_MIGRATIONS_SHOWN = 20;

/**
 * Render a human-readable report.
 */
export function renderText(diff, ref1, ref2, opts = {}) {
  const c = colorize(Boolean(opts.color));
  const out = [];
  const push = (s = '') => out.push(s);

  push(c.bold(`opdiff ${ref1} -> ${ref2}`));
  push();

  if (isEmptyDiff(diff)) {
    push('No deployment surface changes detected.');
    return out.join('\n');
  }

  const { env, migrations, ports, images } = diff;

  if (env.added.length || env.removed.length || env.renamed.length) {
    push(c.bold('ENV VARS'));
    const width = Math.max(
      0,
      ...env.added.map((e) => e.name.length),
      ...env.removed.map((e) => e.name.length),
    );
    for (const e of env.added) {
      push(`  ${c.green('+ added  ')} ${e.name.padEnd(width)}  ${c.dim(site(e.site))}`);
    }
    for (const e of env.removed) {
      push(`  ${c.red('- removed')} ${e.name.padEnd(width)}  ${c.dim('was ' + site(e.site))}`);
    }
    for (const r of env.renamed) {
      push(
        `  ${c.yellow('~ renamed?')} ${r.from} -> ${r.to}  ${c.dim(
          `(similarity ${r.score.toFixed(2)}) ${site(r.toSite)}`,
        )}`,
      );
    }
    push();
  }

  if (migrations.added.length) {
    push(c.bold('MIGRATIONS'));
    const shown = migrations.added.slice(0, MAX_MIGRATIONS_SHOWN);
    for (const p of shown) push(`  ${c.green('+')} ${p}`);
    if (migrations.added.length > shown.length) {
      push(c.dim(`  ... and ${migrations.added.length - shown.length} more`));
    }
    push(c.dim(`  ${migrations.added.length} new migration file(s). Plan a migration step (and a backup) before rollout.`));
    push();
  }

  const hasPorts =
    ports.expose.length || ports.compose.length || ports.listen.added.length || ports.listen.removed.length;
  if (hasPorts) {
    push(c.bold('PORTS'));
    for (const e of ports.expose) {
      const bits = [
        ...e.added.map((p) => c.green(`+${p}`)),
        ...e.removed.map((p) => c.red(`-${p}`)),
      ];
      push(`  ${e.file}  EXPOSE ${bits.join(' ')}`);
    }
    for (const e of ports.compose) {
      const bits = [
        ...e.added.map((p) => c.green(`+"${p}"`)),
        ...e.removed.map((p) => c.red(`-"${p}"`)),
      ];
      push(`  ${e.file}  ports: ${bits.join(' ')}`);
    }
    for (const p of ports.listen.added) {
      push(`  listen site  ${c.green('+' + p.port)}  ${c.dim(`${p.file}:${p.line}`)}`);
    }
    for (const p of ports.listen.removed) {
      push(`  listen site  ${c.red('-' + p.port)}  ${c.dim(`was ${p.file}:${p.line}`)}`);
    }
    push();
  }

  if (images.length) {
    push(c.bold('BASE IMAGES'));
    for (const i of images) {
      for (const ch of i.changed) {
        push(`  ${i.file}  ${c.red(ch.from)} -> ${c.green(ch.to)}`);
      }
      for (const img of i.added) push(`  ${i.file}  ${c.green('+ ' + img)}`);
      for (const img of i.removed) push(`  ${i.file}  ${c.red('- ' + img)}`);
    }
    push();
  }

  // Summary line
  const parts = [];
  if (env.added.length) parts.push(`${env.added.length} env added`);
  if (env.removed.length) parts.push(`${env.removed.length} env removed`);
  if (env.renamed.length) parts.push(`${env.renamed.length} possible rename(s)`);
  if (migrations.added.length) parts.push(`${migrations.added.length} new migration(s)`);
  const portFiles = ports.expose.length + ports.compose.length;
  if (portFiles) parts.push(`port changes in ${portFiles} file(s)`);
  if (ports.listen.added.length + ports.listen.removed.length) {
    parts.push(`${ports.listen.added.length + ports.listen.removed.length} listen-port change(s)`);
  }
  if (images.length) parts.push(`base image change in ${images.length} Dockerfile(s)`);
  push(c.dim(`Summary: ${parts.join(', ')}.`));

  return out.join('\n');
}

/**
 * Render the machine-readable report.
 */
export function renderJson(diff, ref1, ref2) {
  const sited = (e) => ({ name: e.name, file: e.site?.file ?? null, line: e.site?.line ?? null });
  return JSON.stringify(
    {
      tool: 'opdiff',
      from: ref1,
      to: ref2,
      env: {
        added: diff.env.added.map(sited),
        removed: diff.env.removed.map(sited),
        renamed: diff.env.renamed.map((r) => ({
          from: r.from,
          to: r.to,
          score: r.score,
          file: r.toSite?.file ?? null,
          line: r.toSite?.line ?? null,
        })),
      },
      migrations: { added: diff.migrations.added },
      ports: {
        expose: diff.ports.expose,
        compose: diff.ports.compose,
        listen: diff.ports.listen,
      },
      baseImages: diff.images,
    },
    null,
    2,
  );
}
