// Thin git plumbing layer. Reads trees and blobs at arbitrary refs without
// touching the working copy (no checkout, no stash, no temp dirs).

import { execFileSync, spawnSync } from 'node:child_process';

const MAX_BUFFER = 1024 * 1024 * 1024; // 1 GiB

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

/** True if cwd is inside a git repository. */
export function isGitRepo(cwd) {
  try {
    git(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a ref to a commit sha, or null if it does not exist. */
export function resolveRef(ref, cwd) {
  try {
    return git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], cwd).trim() || null;
  } catch {
    return null;
  }
}

/**
 * List all blobs at a ref.
 * @returns {Array<{mode: string, path: string}>} regular-file blobs only (no symlinks, no submodules)
 */
export function listTree(ref, cwd) {
  const out = git(['ls-tree', '-r', '-z', ref], cwd);
  const entries = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type] = rec.slice(0, tab).split(' ');
    if (type !== 'blob' || mode === '120000') continue;
    entries.push({ mode, path: rec.slice(tab + 1) });
  }
  return entries;
}

/**
 * Read many files at a ref in a single `git cat-file --batch` round trip.
 * @returns {Map<string, string>} path -> contents (missing paths are skipped)
 */
export function readFilesAtRef(ref, paths, cwd) {
  const files = new Map();
  if (paths.length === 0) return files;
  const input = paths.map((p) => `${ref}:${p}`).join('\n') + '\n';
  const res = spawnSync('git', ['cat-file', '--batch'], {
    cwd,
    input,
    maxBuffer: MAX_BUFFER,
  });
  if (res.status !== 0) {
    throw new Error(`git cat-file failed: ${res.stderr ? res.stderr.toString() : 'unknown error'}`);
  }
  const buf = res.stdout;
  let off = 0;
  let i = 0;
  while (off < buf.length && i < paths.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl === -1) break;
    const header = buf.toString('utf8', off, nl);
    off = nl + 1;
    if (header.endsWith(' missing')) {
      i++;
      continue;
    }
    const size = parseInt(header.split(' ')[2], 10);
    files.set(paths[i], buf.toString('utf8', off, off + size));
    off += size + 1; // skip content plus trailing newline
    i++;
  }
  return files;
}
