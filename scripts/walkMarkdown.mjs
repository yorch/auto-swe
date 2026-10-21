import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Directory names never descended into. Build output copies the docs to a different
 * depth, so their relative links legitimately do not resolve there. Mirrors `biome.json`'s
 * ignore list.
 */
export const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'output',
  'tmp',
]);

/**
 * Root-relative directories skipped by path rather than by name. `data` is the root-owned Docker
 * bind-mount directory a developer's user cannot read; by name it would also drop a legitimate
 * `docs/data/`.
 */
export const SKIP_PATHS = new Set(['.claude/worktrees', 'data']);

/**
 * Paths git ignores, root-relative. `git ls-files` collapses an ignored directory to one entry
 * ending in `/`, which is stored without the slash; an ignored file is listed by its own path.
 * Empty when git is unavailable — the name and path lists above still apply.
 */
export function gitIgnoredPaths(root) {
  try {
    return new Set(
      execFileSync(
        'git',
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
        .split('\n')
        .filter(Boolean)
        .map((l) => (l.endsWith('/') ? l.slice(0, -1) : l))
    );
  } catch {
    return new Set();
  }
}

/**
 * Every `.md` file under `dir` (root-relative), skipping vendor/build/gitignored
 * directories and gitignored files (generated docs). A directory that cannot be read (EACCES/EPERM) is skipped with a
 * warning instead of crashing the whole check.
 */
export function walkMarkdown(
  root,
  dir,
  { ignored = gitIgnoredPaths(root), warn = console.warn } = {}
) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      warn(`check-doc-drift: skipping unreadable directory ${dir} (${err.code})`);
      return out;
    }
    throw err;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const p = join(dir, entry.name);
    const rel = p.replace(/^\.\//, '');
    if (entry.isDirectory()) {
      if (SKIP_PATHS.has(rel) || ignored.has(rel)) {
        continue;
      }
      out.push(...walkMarkdown(root, p, { ignored, warn }));
    } else if (entry.name.endsWith('.md') && !ignored.has(rel)) {
      out.push(p);
    }
  }
  return out;
}
