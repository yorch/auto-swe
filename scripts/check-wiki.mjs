#!/usr/bin/env node
/**
 * Generated-wiki freshness check.
 *
 * `wiki/` is a generated, commit-pinned snapshot, not a living doc: every
 * citation URL is pinned to `commit_sha_full` in `wiki/_meta.json`, so the pages
 * stay internally correct forever while drifting from `main`. Two things can go
 * wrong silently, and this script checks both:
 *
 *   1. Integrity — a citation points at a path or line range that does not exist
 *      at the pinned commit, or at a different commit than `_meta.json` says.
 *   2. Staleness — the wiki is too far behind HEAD to be trusted. Measured in
 *      commits outside `wiki/` since the pinned commit, and in days since
 *      `indexed_at`. Either over its threshold fails.
 *
 * It deliberately does not run in the main CI gate: the repo merges many
 * commits a day, so a staleness failure would block unrelated PRs. It runs in
 * `.github/workflows/wiki.yml`: integrity only on pull requests that touch the
 * wiki or the check (WIKI_SKIP_STALENESS=1), integrity plus staleness on the
 * weekly schedule and on manual dispatch.
 *
 * Needs full git history (the pinned commit must be reachable). No dependencies.
 *
 * Run: `yarn wiki:check`
 * Env: WIKI_MAX_COMMITS (default 150), WIKI_MAX_DAYS (default 21),
 *      WIKI_SKIP_STALENESS=1 (integrity checks only)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIKI = join(ROOT, 'wiki');
const MAX_COMMITS = Number(process.env.WIKI_MAX_COMMITS ?? 150);
const MAX_DAYS = Number(process.env.WIKI_MAX_DAYS ?? 21);
const SKIP_STALENESS = process.env.WIKI_SKIP_STALENESS === '1';

const git = (...args) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const gitOk = (...args) => {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
};

const failures = [];
const fail = (where, detail) => failures.push({ detail, where });

function die(message) {
  console.error(`wiki:check — ${message}`);
  process.exit(1);
}

if (!existsSync(join(WIKI, '_meta.json'))) {
  die('wiki/_meta.json not found');
}
const meta = JSON.parse(readFileSync(join(WIKI, '_meta.json'), 'utf8'));
const sha = meta.commit_sha_full;
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
  die('wiki/_meta.json has no valid commit_sha_full');
}

if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
  die(
    'shallow clone — fetch full history first (`git fetch --unshallow`, or actions/checkout with fetch-depth: 0)'
  );
}
if (!gitOk('cat-file', '-e', `${sha}^{commit}`)) {
  die(`pinned commit ${sha} is not in this clone — fetch full history`);
}

// --- Integrity ---------------------------------------------------------------

if (!gitOk('merge-base', '--is-ancestor', sha, 'HEAD')) {
  fail('wiki/_meta.json', `pinned commit ${sha} is not an ancestor of HEAD`);
}

// NUL-separated: without -z git quotes non-ASCII or special paths and the match silently fails.
const tree = new Set(git('ls-tree', '-r', '-z', '--name-only', sha).split('\0').filter(Boolean));
const lineCounts = new Map();
function linesAt(path) {
  if (!lineCounts.has(path)) {
    const text = git('show', `${sha}:${path}`);
    lineCounts.set(path, text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  }
  return lineCounts.get(path);
}

function pages(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...pages(p));
    } else if (entry.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

// A citation is a blob URL (optionally with a line anchor) or a tree URL, all pinned to a commit.
const CITATION =
  /https:\/\/github\.com\/yorch\/auto-swe\/(blob|tree)\/([0-9a-fA-F]{7,40})(?:\/([^\s#)>\]"']*))?(?:#L(\d+)(?:-L(\d+))?)?/g;
// A markdown link whose label states a range (`file.ts:L10-L20`, `L10-L20`, `file.ts#L10`)
// must agree with the range in its URL.
const LINK = new RegExp(`\\[([^\\]]*)\\]\\((${CITATION.source})\\)`, 'g');
const LABEL_RANGE = /(?:^|[:#\s])L(\d+)(?:-L?(\d+))?$/;
const safeDecode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};
const citedPaths = new Set();
let citations = 0;
const pageList = pages(WIKI);

for (const file of pageList) {
  const page = file.slice(ROOT.length + 1);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(CITATION)) {
    const [url, kind, refSha, rawPath = '', a, b] = m;
    const path = safeDecode(rawPath.replace(/\/$/, ''));
    citations++;
    if (path === null) {
      fail(page, `${url} — path is not valid percent-encoding`);
      continue;
    }
    if (!sha.startsWith(refSha.toLowerCase())) {
      fail(page, `${url} — pinned to ${refSha}, _meta.json says ${sha.slice(0, 8)}`);
      continue;
    }
    if (kind === 'tree') {
      if (path !== '' && !gitOk('cat-file', '-e', `${sha}:${path}`)) {
        fail(page, `${url} — path does not exist at the pinned commit`);
      }
      continue;
    }
    if (!tree.has(path)) {
      fail(page, `${url} — path does not exist at the pinned commit`);
      continue;
    }
    citedPaths.add(path);
    if (a === undefined) {
      continue;
    }
    const start = Number(a);
    const end = b === undefined ? start : Number(b);
    const total = linesAt(path);
    if (start < 1 || end < start || end > total) {
      fail(page, `${url} — range L${start}-L${end} outside ${path} (${total} lines)`);
    }
  }
  for (const m of text.matchAll(LINK)) {
    const label = m[1];
    const lm = LABEL_RANGE.exec(label);
    if (!lm) {
      continue;
    }
    const [, , url, , , , urlA, urlB] = m;
    const urlStart = urlA === undefined ? undefined : Number(urlA);
    const urlEnd = urlB === undefined ? urlStart : Number(urlB);
    const labelStart = Number(lm[1]);
    const labelEnd = lm[2] === undefined ? labelStart : Number(lm[2]);
    if (urlStart !== labelStart || urlEnd !== labelEnd) {
      fail(page, `[${label}] — label range differs from the URL anchor in ${url}`);
    }
  }
}

// --- Staleness ---------------------------------------------------------------

// Everything except the wiki itself: the pages cite packages, .github, scripts, docs and site.
const commitsBehind = Number(
  git('rev-list', '--count', `${sha}..HEAD`, '--', '.', ':(exclude)wiki').trim()
);
const indexedAt = new Date(meta.indexed_at);
const daysOld = Number.isNaN(indexedAt.getTime())
  ? null
  : (Date.now() - indexedAt.getTime()) / 86_400_000;

if (daysOld === null) {
  fail('wiki/_meta.json', `indexed_at "${meta.indexed_at}" is not a valid date`);
}
if (!SKIP_STALENESS) {
  if (commitsBehind > MAX_COMMITS) {
    fail(
      'staleness',
      `${commitsBehind} commits outside wiki/ since the pinned commit (limit ${MAX_COMMITS})`
    );
  }
  if (daysOld !== null && daysOld > MAX_DAYS) {
    fail('staleness', `indexed ${daysOld.toFixed(1)} days ago (limit ${MAX_DAYS})`);
  }
}

// Informational: how many cited files differ between the pinned commit and HEAD.
const changed = new Set(git('diff', '--name-only', '-z', sha, 'HEAD').split('\0').filter(Boolean));
const changedCited = [...citedPaths].filter((p) => changed.has(p) || !existsSync(join(ROOT, p)));

console.log(
  `wiki:check — ${pageList.length} pages, ${citations} citations, ${citedPaths.size} cited files`
);
console.log(`  pinned ${sha.slice(0, 8)}, indexed ${meta.indexed_at}`);
console.log(
  `  ${commitsBehind} commits outside wiki/ behind HEAD (limit ${MAX_COMMITS}); ` +
    `${daysOld === null ? '?' : daysOld.toFixed(1)} days old (limit ${MAX_DAYS})` +
    (SKIP_STALENESS ? ' — staleness not enforced (WIKI_SKIP_STALENESS=1)' : '')
);
console.log(
  `  ${changedCited.length}/${citedPaths.size} cited files changed since the pinned commit` +
    (citedPaths.size ? ` (${Math.round((100 * changedCited.length) / citedPaths.size)}%)` : '')
);

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) {
    console.error(`  ${f.where}: ${f.detail}`);
  }
  console.error(
    '\nRefresh: regenerate the wiki with the repo-wiki-generator skill at current main,\n' +
      'then update wiki/_meta.json (commit_sha, commit_sha_full, indexed_at).'
  );
  process.exit(1);
}
console.log('wiki:check passed');
