#!/usr/bin/env node
/**
 * Documentation drift check.
 *
 * Prose has no compiler, so the parts of the living docs that restate something the code
 * owns rot silently. This script is the compiler for those: dependency and image versions,
 * forbidden status prose, setting keys, repository paths, dashboard routes, relative links,
 * the agent roster, and the `## Limitations` section every capability doc carries.
 *
 * Counts of what the schema, the spec, the skill set or the registries contain ("15 node
 * types", "111 Prisma models") are deliberately NOT checked: the docs do not state them,
 * because they churn on every change and carry almost no information — the source is the
 * authority. Frozen docs under `docs/history/` are never checked.
 *
 * Run: `yarn docs:check`
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkMarkdown } from './walkMarkdown.mjs';

// `DOC_DRIFT_ROOT` points the check at a fixture tree; the test suite uses it.
const ROOT = process.env.DOC_DRIFT_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// Dependency versions
//
// The tech-stack tables in AGENTS.md and README.md restate versions that
// package.json already owns. That duplication is the point — an agent reads the
// table, not the lockfile — but it rots on every upgrade, silently and in more
// than one place at a time. So derive each version from the manifest.
//
// Docs may truncate ("Fastify 5.11", "TypeScript 6"), so a claim passes when it
// is a dot-boundary *prefix* of the real version: 5.11 matches 5.11.0, 5.8 does
// not. Versions appear in two shapes — inline prose and a trailing table cell —
// and one cell may carry several versions ("16.2.7 / 19.2.7 / 4.3.0"), so a
// table claim passes if any version in the cell matches.
// ---------------------------------------------------------------------------

const manifest = (p) => JSON.parse(read(p));
const rootPkg = manifest('package.json');
/**
 * Highest-precedence declared version for a dependency, across all workspaces.
 *
 * Expanded from the root `workspaces` globs rather than hardcoded to
 * `packages/*`. A workspace living anywhere else — `site`, say — would
 * otherwise be invisible here, and every version it declares would be a
 * version no doc can be checked against. That failure is silent in the worst
 * direction: the check still reports a comfortable count of verified versions,
 * having skipped the ones it could not see.
 */
const MANIFESTS = [
  'package.json',
  ...rootPkg.workspaces.flatMap((pattern) =>
    pattern.endsWith('/*')
      ? readdirSync(join(ROOT, pattern.slice(0, -2))).map(
          (d) => `${pattern.slice(0, -2)}/${d}/package.json`
        )
      : [`${pattern}/package.json`]
  ),
];
const depVersion = (name) => {
  for (const p of MANIFESTS) {
    if (!existsSync(join(ROOT, p))) {
      continue;
    }
    const pkg = manifest(p);
    const v = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
    if (v) {
      return v.replace(/^[\^~>=<\s]+/, '');
    }
  }
  throw new Error(`could not find a declared version for '${name}'`);
};

/** `4.18` and `4.18.0` both satisfy `4.18.0`; `4.17` and `4.1` do not. */
const isVersionPrefix = (claimed, actual) => actual === claimed || actual.startsWith(`${claimed}.`);

const VERSIONED_DEPS = [
  { actual: rootPkg.packageManager.replace(/^yarn@/, ''), name: 'Yarn', pattern: 'Yarn' },
  { actual: depVersion('fastify'), name: 'Fastify', pattern: 'Fastify' },
  { actual: depVersion('typescript'), name: 'TypeScript', pattern: 'TypeScript' },
  { actual: depVersion('prisma'), name: 'Prisma', pattern: 'Prisma' },
  { actual: depVersion('zod'), name: 'Zod', pattern: 'Zod' },
  { actual: depVersion('vitest'), name: 'Vitest', pattern: 'Vitest' },
  { actual: depVersion('@biomejs/biome'), name: 'Biome', pattern: 'Biome' },
  { actual: depVersion('@mastra/core'), name: 'Mastra', pattern: 'Mastra' },
  { actual: depVersion('next'), name: 'Next.js', pattern: 'Next\\.js' },
  { actual: depVersion('react'), name: 'React', pattern: 'React' },
  { actual: depVersion('tailwindcss'), name: 'Tailwind CSS', pattern: 'Tailwind(?: CSS)?' },
  {
    actual: depVersion('@tanstack/react-query'),
    name: 'TanStack Query',
    pattern: 'TanStack Query',
  },
  { actual: depVersion('zustand'), name: 'Zustand', pattern: 'Zustand' },
  { actual: depVersion('astro'), name: 'Astro', pattern: 'Astro' },
  {
    actual: depVersion('@astrojs/starlight'),
    name: 'Starlight',
    pattern: '(?:@astrojs/)?Starlight',
  },
  {
    actual: depVersion('@temporalio/worker'),
    name: '@temporalio SDK',
    // Never bare "Temporal" — that is the server image, on its own release train.
    pattern: '@temporalio(?:/[\\w{},*-]+)?(?: SDK)?',
  },
];

const VERSION = '(\\d+(?:\\.\\d+)*)';

// ---------------------------------------------------------------------------
// Container image versions
//
// The compose files own the image tags (`temporalio/server:${TEMPORAL_VERSION:-1.31.2}`),
// and `.node-version` owns the Node major. The tech-stack tables and the
// deployment runbook restate both, so derive them the same way as the npm
// versions above. A claim passes when either side is a dot-boundary prefix of
// the other ("admin-tools 1.31" for 1.31.2; "Node.js >=26.0.0" for 26).
// ---------------------------------------------------------------------------

const composeSrc = read('docker-compose.infra.yml') + read('docker-compose.app.yml');
/**
 * Default tag of `<image>` in the compose files — `${VAR:-tag}` or a literal tag. A
 * `tag@sha256:…` digest pin is not part of the version, so the match stops at `@`.
 */
const imageTag = (image) => {
  const name = image.replace(/[./]/g, '\\$&');
  const m = composeSrc.match(
    new RegExp(`image:\\s*${name}:(?:\\$\\{[A-Z_]+:-([^}@]+)|([^\\s@]+))`)
  );
  if (!m) {
    throw new Error(`could not find an image tag for '${image}' in the compose files`);
  }
  return m[1] ?? m[2];
};
const nodeMajor = read('.node-version').trim();

/**
 * Major of the default agent workspace image, from the `resolveWorkflowDefaults`
 * fallback that the worker actually reads. Tracked separately from `nodeMajor`
 * because the sandbox agents work inside is not upgraded in lockstep with the
 * services: it lagged deliberately when node:26 dropped the Corepack-provided
 * `yarn`/`pnpm` shims that agents need for Yarn and pnpm target repos.
 */
const workspaceImageMajor = (() => {
  const src = read('packages/shared/src/lib/systemConfig.ts');
  const m = src.match(/'WORKSPACE_IMAGE',\s*'node:(\d+)-alpine'/);
  if (!m) {
    throw new Error(
      'could not find the WORKSPACE_IMAGE default in packages/shared/src/lib/systemConfig.ts — ' +
        'update this matcher if the resolver changed shape'
    );
  }
  return m[1];
})();

const IMAGE_DEPS = [
  { actual: imageTag('temporalio/server'), name: 'temporalio/server' },
  { actual: imageTag('temporalio/admin-tools'), name: 'temporalio/admin-tools' },
  { actual: imageTag('temporalio/ui'), name: 'temporalio/ui' },
  { actual: imageTag('grafana/otel-lgtm'), name: 'grafana/otel-lgtm' },
  { actual: imageTag('pgvector/pgvector'), name: 'pgvector/pgvector' },
  { actual: imageTag('dxflrs/garage'), name: 'dxflrs/garage' },
];
const IMAGE_TAG = '([\\w][\\w.-]*)';

/** Either side may be the truncated one: "1.31" ~ "1.31.2", and "26.0.0" ~ "26". */
const versionsAgree = (a, b) => isVersionPrefix(a, b) || isVersionPrefix(b, a);

const checkImageVersions = (file, line, lineNo) => {
  for (const dep of IMAGE_DEPS) {
    const re = new RegExp(`${dep.name.replace(/[./]/g, '\\$&')}:${IMAGE_TAG}`, 'g');
    for (const m of line.matchAll(re)) {
      if (m[1] !== dep.actual) {
        versionFailures.push({
          actual: dep.actual,
          file,
          line: lineNo,
          name: dep.name,
          text: m[0],
        });
      }
    }
  }
  // Prose shorthand for the server image: "Temporal 1.31" (never "@temporalio", the SDK).
  const server = IMAGE_DEPS[0];
  for (const m of line.matchAll(
    new RegExp(`(?<![\\w@/])Temporal(?: server)?\\s+v?${VERSION}`, 'g')
  )) {
    if (!versionsAgree(m[1], server.actual)) {
      versionFailures.push({
        actual: server.actual,
        file,
        line: lineNo,
        name: 'Temporal server',
        text: m[0],
      });
    }
  }
  // Node: "Node.js >=26.0.0", "Node.js ≥ 26".
  for (const m of line.matchAll(
    new RegExp(`\\bNode(?:\\.js)?\\s+(?:>=|≥)?\\s*v?${VERSION}`, 'gi')
  )) {
    if (!versionsAgree(m[1], nodeMajor)) {
      versionFailures.push({ actual: nodeMajor, file, line: lineNo, name: 'Node.js', text: m[0] });
    }
  }
  // The agent workspace base image is NOT the platform's Node major. It is an
  // independent knob — the image agent-authored commands run inside — and it is
  // deliberately allowed to lag `.node-version`, so it is checked against its
  // own source of truth (the `resolveWorkflowDefaults` fallback) rather than
  // against the runtime the services are built on. `-slim` counts too: the
  // `-alpine`-only form let a stale `node:24-slim` through unnoticed.
  for (const m of line.matchAll(/\bnode:(\d+)-(?:alpine|slim)\b/g)) {
    if (m[1] !== workspaceImageMajor) {
      versionFailures.push({
        actual: workspaceImageMajor,
        file,
        line: lineNo,
        name: 'workspace image',
        text: m[0],
      });
    }
  }
};

/** Every version-looking token in a string, e.g. "16.2.7 / 19.2.7" → both. */
const versionsIn = (cell) => cell.match(/\d+(?:\.\d+)*/g) ?? [];

const versionFailures = [];
// `\b` cannot delimit a pattern that starts or ends on a non-word character:
// in "| @temporalio/{client,worker} |" there is no word boundary before `@` or
// after `}`, so a `\b`-wrapped pattern silently matches nothing and the claim
// goes unchecked — which is how the @temporalio version rotted four minors
// behind the manifest. These lookarounds delimit on word characters when the
// pattern ends in one and are inert when it doesn't.
const LEFT = '(?<![\\w@])';
const RIGHT = '(?![\\w-])';
const checkVersions = (file, line, lineNo) => {
  for (const dep of VERSIONED_DEPS) {
    const inline = new RegExp(`${LEFT}${dep.pattern}\\s+v?${VERSION}`, 'gi');
    // A trailing table cell: "| Fastify | 5.11.0 |".
    const cell = new RegExp(
      `\\|[^|\\n]*?${LEFT}${dep.pattern}${RIGHT}[^|\\n]*\\|\\s*(v?\\d[\\d./\\s]*?)\\s*\\|`,
      'gi'
    );

    for (const m of line.matchAll(inline)) {
      if (!isVersionPrefix(m[1], dep.actual)) {
        versionFailures.push({
          actual: dep.actual,
          file,
          line: lineNo,
          name: dep.name,
          text: m[0].trim(),
        });
      }
    }
    for (const m of line.matchAll(cell)) {
      const claimed = versionsIn(m[1]);
      if (claimed.length > 0 && !claimed.some((c) => isVersionPrefix(c, dep.actual))) {
        versionFailures.push({
          actual: dep.actual,
          file,
          line: lineNo,
          name: dep.name,
          text: `${dep.name} → ${m[1].trim()}`,
        });
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Forbidden status prose
//
// Living docs describe the system in present tense. Shipped-status narration,
// phase labels, PR numbers, and roadmap promises belong in git history and the
// pull request — they are exactly the prose that rots without anyone noticing,
// because nothing recompiles when the promise is kept or abandoned.
//
// Inline code and quoted strings are stripped first, so the convention can
// quote the very phrases it bans without tripping its own check.
// ---------------------------------------------------------------------------

const FORBIDDEN_PROSE = [
  { hint: 'phase label', re: /\(\s*(?:phase|P)\s*\d/i },
  { hint: 'phase/workstream label', re: /\bP\d\s*\/\s*WS\d/i },
  { hint: 'PR number', re: /\bPRs?\s*#\d+/i },
  { hint: 'shipped-status narration', re: /\bnow shipped\b/i },
  { hint: 'roadmap promise', re: /\bcoming soon\b/i },
  { hint: 'roadmap promise', re: /\bin a follow-up\b/i },
  { hint: 'roadmap promise', re: /\b(?:it'?ll|it will) come\b/i },
  { hint: 'roadmap promise', re: /\bwill come in\b/i },
  { hint: 'roadmap section', re: /\bfuture refinements?\b/i },
  // A "Status:" header is how a direction document announces it is not describing
  // the system as built — that document belongs in docs/history/.
  { hint: 'status header', re: /^\s*(?:>\s*)?\**status\**\s*:/i },
  { hint: 'roadmap promise', re: /\bnot yet (?:implemented|built|shipped|wired(?: up)?)\b/i },
];

const stripQuoted = (line) => line.replace(/`[^`]*`/g, '').replace(/"[^"]*"/g, '');

const proseFailures = [];
const checkProse = (file, line, lineNo) => {
  const prose = stripQuoted(line);
  for (const { hint, re } of FORBIDDEN_PROSE) {
    const m = prose.match(re);
    if (m) {
      proseFailures.push({ file, hint, line: lineNo, text: m[0].trim() });
    }
  }
};

// ---------------------------------------------------------------------------
// Scan the living docs
// ---------------------------------------------------------------------------

/** Living docs only — `docs/history/` is frozen by definition and exempt. */
// ---------------------------------------------------------------------------
// Setting-registry keys named in prose
//
// A doc that names a setting is quoting an identifier the code owns, and the
// registry enforces that a key is prefixed with its own group — so a doc can
// state a plausible-looking key that no `resolveSetting` call will ever match.
// Nothing else here catches that: the key is not a count, not a version, and
// not a link, so every other rule in this file waves it through.
//
// Two shapes are rejected, chosen to stay quiet on ordinary prose:
//
//   1. right suffix, wrong group — `implementer.maxToolOutputChars` for a key
//      registered as `workspace.maxToolOutputChars`. This is the likely failure
//      whenever a knob is renamed to satisfy the group-prefix invariant.
//   2. real group, unknown suffix — `workspace.maxToolOutput`, i.e. a typo or a
//      key that has since been removed.
//
// A dotted token that matches neither is not treated as a setting reference at
// all, so `package.json` and `schema.prisma` pass through untouched.
// ---------------------------------------------------------------------------

const registrySrc = read('packages/shared/src/config/registry.ts');

/** Keys of `SETTING_DEFINITIONS`, e.g. `workspace.maxToolOutputChars`. */
const settingKeys = new Set(
  [...registrySrc.matchAll(/^\s*'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9]+)':\s*defineSetting\(/gm)].map(
    (m) => m[1]
  )
);
if (settingKeys.size === 0) {
  throw new Error('could not locate any SETTING_DEFINITIONS keys');
}

/**
 * Every registered key, for the count the report prints. `settingKeys` above is
 * the set the prose check matches against and only holds `group.suffix` keys:
 * a key whose suffix is itself dotted (`skills.import.*`) is not a token the
 * two-segment prose pattern can name, so it is counted here but not matched.
 */
const registeredKeyCount = new Set(
  [
    ...registrySrc.matchAll(/^\s*'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)':\s*defineSetting\(/gm),
  ].map((m) => m[1])
).size;

/** suffix → the real key(s) carrying it, for "did you mean" on a wrong group. */
const settingKeysBySuffix = new Map();
for (const key of settingKeys) {
  const suffix = key.slice(key.indexOf('.') + 1);
  settingKeysBySuffix.set(suffix, [...(settingKeysBySuffix.get(suffix) ?? []), key]);
}

/** Group prefixes actually in use — `channel`, `memory`, `workflow`, `workspace`. */
const settingGroups = new Set([...settingKeys].map((k) => k.slice(0, k.indexOf('.'))));

const settingFailures = [];
const checkSettingKeys = (file, line, lineNo) => {
  // Backticked only: a setting named in running prose without code formatting is
  // a style problem, not a correctness one, and matching bare words here would
  // flag every sentence containing a period.
  for (const m of line.matchAll(/`([a-z][a-zA-Z0-9]*)\.([a-zA-Z][a-zA-Z0-9]*)`/g)) {
    const group = m[1];
    const suffix = m[2];
    const token = `${group}.${suffix}`;
    if (settingKeys.has(token)) {
      continue;
    }
    const bySuffix = settingKeysBySuffix.get(suffix);
    if (bySuffix) {
      settingFailures.push({ file, line: lineNo, suggest: bySuffix.join(' / '), token });
      // Every registered suffix is camelCase, so requiring an interior capital
      // keeps `workspace.ts` and `channel.json` out of the "real group, unknown
      // suffix" branch — a filename that happens to lead with a group name is
      // not a setting reference.
    } else if (settingGroups.has(group) && /[A-Z]/.test(suffix)) {
      settingFailures.push({ file, line: lineNo, suggest: '(no such key in the registry)', token });
    }
  }
};

const targets = [
  'AGENTS.md',
  'README.md',
  // Added after its "Node >= 24" survived a whole-repo version sweep: it is a
  // living doc that tells a human which runtime to install, and it was the one
  // such doc CI never read.
  'CONTRIBUTING.md',
  'packages/cli/README.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('docs', f)),
];

for (const file of targets) {
  const lines = read(file).split('\n');
  lines.forEach((line, i) => {
    checkVersions(relative('.', file), line, i + 1);
    checkImageVersions(relative('.', file), line, i + 1);
    checkProse(relative('.', file), line, i + 1);
    checkSettingKeys(relative('.', file), line, i + 1);
  });
}

// ---------------------------------------------------------------------------
// Every capability doc must state its gaps
//
// Known gaps live next to the feature they belong to, not in a central list that
// drifts. That only works if every capability doc actually has one — so require it.
//
// This is an EXEMPT list, not an allowlist, and that is the point: an allowlist
// exempts a new doc by omission, which is how `model-configuration.md` went
// uncovered. Every doc under `docs/` is checked unless it is named here, so
// adding a doc opts it in and skipping one is a deliberate, reviewable edit.
//
// Only pure procedure or pure definition belongs here. A runbook tells you which
// buttons to press and a glossary says what a word means; neither makes a claim
// about what the system can do, so neither has gaps of its own to state — each
// glossary entry links to the doc that does.
// ---------------------------------------------------------------------------

const GAP_EXEMPT_DOCS = new Set([
  'docs/README.md', // index
  'docs/concepts.md', // glossary
  'docs/deployment.md', // runbook
  'docs/quickstart.md', // runbook
  'docs/github-app-setup.md', // runbook
  'docs/oauth-setup.md', // runbook
  'docs/slack-app-setup.md', // runbook
]);
const GAP_HEADING = /^#{2,3} .*(limitation|not built|non-goal|out of scope|maturity)/im;

const gapCheckedDocs = readdirSync(join(ROOT, 'docs'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `docs/${f}`)
  .filter((d) => !GAP_EXEMPT_DOCS.has(d))
  .sort();

const missingGaps = gapCheckedDocs.filter((d) => !GAP_HEADING.test(read(d)));

// A doc listed as exempt but since deleted is a stale exemption — it would
// silently keep a future doc of the same name uncovered.
const staleExemptions = [...GAP_EXEMPT_DOCS].filter((d) => !existsSync(join(ROOT, d)));

// ---------------------------------------------------------------------------
// Seeded agents named in the roster
//
// A roster that lists ten of seventeen agents reads as though it lists them
// all — which is what happened: the seven agents seeded for content, support
// and product work were absent from the summary in AGENTS.md.
//
// Only the two docs that claim to enumerate the roster are checked. Every other
// doc mentions agents in passing and has no business listing all of them.
// ---------------------------------------------------------------------------

const ROSTER_DOCS = ['AGENTS.md', 'docs/agents.md'];

const builtinAgentsSrc = read('packages/shared/src/lib/syncBuiltins.ts');
const seededAgentKeys = [...builtinAgentsSrc.matchAll(/^\s+key: '([a-zA-Z]+)',$/gm)].map(
  (m) => m[1]
);
// A roster check over zero agents passes by checking nothing. If the shape of the `key:` lines in
// syncBuiltins.ts changes, say so instead of going quiet.
if (seededAgentKeys.length === 0) {
  throw new Error(
    'check-doc-drift: found no seeded agent keys in packages/shared/src/lib/syncBuiltins.ts; ' +
      'the roster check would pass without checking anything. Update the key pattern.'
  );
}

const rosterFailures = [];
for (const doc of ROSTER_DOCS) {
  if (!existsSync(join(ROOT, doc))) {
    continue;
  }
  const src = read(doc);
  const missingKeys = seededAgentKeys.filter((k) => !src.includes(`\`${k}\``));
  if (missingKeys.length > 0) {
    rosterFailures.push({ doc, keys: missingKeys });
  }
}

// ---------------------------------------------------------------------------
// Repository paths named in prose
//
// A doc that says "see `packages/worker/src/lib/config/cache.ts`" is pointing
// at a file, and moving that file leaves the sentence reading perfectly while
// the path resolves to nothing. The relative-link check below covers markdown
// links; it never looks inside backticks, which is where most of these live.
// ---------------------------------------------------------------------------

/** A backticked path rooted at a real top-level directory in this repo. */
const REPO_PATH = /`((?:packages|scripts|infra|site|docs)\/[A-Za-z0-9_./@-]+)`/g;

/**
 * A backticked package-relative path — `src/lib/github.ts` — as the per-package
 * tables in architecture.md write them. `[` and `]` are allowed so a Next.js
 * dynamic segment (`src/app/runs/[id]/`) is checked rather than skipped.
 */
const PACKAGE_PATH = /`(src\/[A-Za-z0-9_./@[\]-]+)`/g;

/** A heading line: its level, and the package it names in backticks, if any. */
const HEADING = /^(#{1,6})\s/;
const HEADING_PACKAGE = /`packages\/([A-Za-z0-9_-]+)`/;

const pathFailures = [];
for (const file of targets) {
  // Package-relative paths resolve against the package whose section they sit
  // in: a heading naming `packages/<pkg>` opens that package's section, and the
  // next heading at the same or a shallower level closes it. Outside such a
  // section a bare `src/...` path is ambiguous, so it is not checked.
  let section = null; // { pkg, level }
  read(file)
    .split('\n')
    .forEach((line, i) => {
      const heading = line.match(HEADING);
      if (heading) {
        const level = heading[1].length;
        const named = line.match(HEADING_PACKAGE);
        if (named) {
          section = { level, pkg: named[1] };
        } else if (section && level <= section.level) {
          section = null;
        }
      }
      for (const m of line.matchAll(REPO_PATH)) {
        const p = m[1].replace(/\/$/, '');
        // A trailing `*` is a glob standing in for a set of files.
        if (p.includes('*')) {
          continue;
        }
        if (existsSync(join(ROOT, p))) {
          continue;
        }
        pathFailures.push({ file, line: i + 1, path: p });
      }
      if (!section) {
        return;
      }
      for (const m of line.matchAll(PACKAGE_PATH)) {
        const rel = m[1].replace(/\/$/, '');
        if (rel.includes('*')) {
          continue;
        }
        const p = `packages/${section.pkg}/${rel}`;
        if (existsSync(join(ROOT, p))) {
          continue;
        }
        pathFailures.push({ file, line: i + 1, path: p });
      }
    });
}

// ---------------------------------------------------------------------------
// Dashboard routes named in prose
//
// A doc that tells an operator to go to `/admin/integrations` is quoting a URL
// the web app owns, and nothing else here notices when the app moves it. The
// dashboard's navigation has been regrouped more than once, and once the docs
// kept pointing at pages that had moved for months: 89 references across 12
// files, all of them reading perfectly and none of them resolving.
//
// The trap this has to avoid is that `/api/v1/admin/...` is a live gateway
// prefix beside the dashboard's own `/admin` pages, so `/admin/config` and
// `/admin/scanner-patterns` are correct API paths. Only a reference that is
// unambiguously a *page* is checked: one whose line does not mention an API,
// and whose first segment is a section the dashboard actually has.
// ---------------------------------------------------------------------------

/** Every route the Next.js app renders, derived from its `page.tsx` files. */
const appRoutes = (() => {
  const base = join(ROOT, 'packages/web/src/app');
  const out = new Set();
  const walkApp = (dir, url) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        if (entry.name === 'page.tsx') {
          out.add(url === '' ? '/' : url);
        }
        continue;
      }
      // Route groups `(name)` do not appear in the URL; dynamic `[id]` segments
      // are kept as a wildcard marker so a doc may name a concrete id.
      const seg = entry.name.startsWith('(') ? '' : `/${entry.name}`;
      walkApp(join(dir, entry.name), url + seg);
    }
  };
  if (existsSync(base)) {
    walkApp(base, '');
  }
  return out;
})();

/** Top-level sections the dashboard serves, e.g. `admin`, `library`, `runs`. */
const appSections = new Set([...appRoutes].map((r) => r.split('/')[1]).filter(Boolean));

/**
 * Does the app serve this path? A `[slug]` segment in the route matches any one
 * segment the doc wrote there, so `/docs/agents` resolves against `/docs/[slug]`
 * — otherwise every doc that names a concrete page would be reported.
 */
const routeExists = (path) => {
  if (appRoutes.has(path)) {
    return true;
  }
  const parts = path.split('/').filter(Boolean);
  return [...appRoutes].some((route) => {
    const rp = route.split('/').filter(Boolean);
    if (rp.length !== parts.length) {
      return false;
    }
    return rp.every((seg, i) => seg.startsWith('[') || seg === parts[i]);
  });
};

/**
 * The dashboard's old addresses, read from `LEGACY_REDIRECTS` in `next.config.ts`. They still
 * open through a redirect, so a doc that names one reads fine and works, which is exactly why
 * nothing else notices: the docs keep teaching the old map. `:path*` marks a prefix rule.
 */
const legacyRedirects = (() => {
  const file = 'packages/web/next.config.ts';
  if (!existsSync(join(ROOT, file))) {
    return [];
  }
  const text = read(file);
  const rules = [
    ...text.matchAll(/\{\s*destination:\s*'([^']+)',\s*source:\s*'([^']+)'\s*\}/g),
  ].map(([, destination, source]) => ({ destination, source }));
  // A rule written in another shape (an extra key, double quotes) would drop out of the match, and
  // a list that drops out entirely would make this check refuse nothing while still passing.
  if (text.includes('LEGACY_REDIRECTS') && rules.length === 0) {
    throw new Error(
      `${file} declares LEGACY_REDIRECTS but no rule matched the { destination, source } shape ` +
        'this check reads; update the pattern in scripts/check-doc-drift.mjs.'
    );
  }
  return rules;
})();

/** The redirect an old address would take, or undefined when the path is not an old one. */
const legacyRedirectFor = (path) =>
  legacyRedirects.find(({ source }) =>
    source.endsWith('/:path*')
      ? path.startsWith(`${source.slice(0, -'/:path*'.length)}/`)
      : path === source
  );

/** A sentence about the redirects themselves names old addresses on purpose. */
const REDIRECT_CONTEXT = /\bredirect|\bbookmark/i;

/** A path is a page reference when its first segment names a real dashboard section. */
const PAGE_LIKE = /`(\/(?:[a-z][a-z0-9-]*)(?:\/[a-z0-9[\]:-]+)*)`/g;

/** Lines that are talking about the HTTP API, where `/admin/...` is correct. */
const API_CONTEXT =
  /\bapi\/v1\b|\bAPI\b|\bendpoint\b|\bGET\b|\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b|\bcurl\b/;

const routeFailures = [];
for (const file of targets) {
  read(file)
    .split('\n')
    .forEach((line, i) => {
      if (API_CONTEXT.test(line)) {
        return;
      }
      for (const m of line.matchAll(PAGE_LIKE)) {
        const path = m[1];
        const legacy = REDIRECT_CONTEXT.test(line) ? undefined : legacyRedirectFor(path);
        if (legacy) {
          // A prefix rule carries the rest of the path over, as the redirect itself does.
          const rest = legacy.source.endsWith('/:path*')
            ? path.slice(legacy.source.length - '/:path*'.length + 1)
            : '';
          const movedTo = legacy.destination.replace(':path*', rest);
          routeFailures.push({ file, line: i + 1, movedTo, path });
          continue;
        }
        const section = path.split('/')[1];
        if (!appSections.has(section)) {
          continue;
        }
        if (routeExists(path)) {
          continue;
        }
        routeFailures.push({ file, line: i + 1, path });
      }
    });
}

// ---------------------------------------------------------------------------
// Broken relative links
//
// Moving a doc silently breaks every link into it. Unlike the checks above this
// scans the whole tree, frozen docs included — a dead link is wrong everywhere.
// ---------------------------------------------------------------------------

const walk = (dir) => walkMarkdown(ROOT, dir);

/**
 * GitHub-style heading slug: lowercase, drop everything but letters, digits,
 * spaces, `_` and `-`, then every space → `-` (runs are NOT collapsed, which is
 * why "## 8. Observability & Cost" is `8-observability--cost`). Repeated
 * headings get `-1`, `-2`, … like GitHub.
 */
const headingAnchors = (src) => {
  const seen = new Map();
  const out = new Set();
  for (const m of src.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = m[1]
      .replace(/`([^`]*)`/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
};
const anchorCache = new Map();
const anchorsOf = (absPath) => {
  if (!anchorCache.has(absPath)) {
    anchorCache.set(absPath, headingAnchors(readFileSync(absPath, 'utf8')));
  }
  return anchorCache.get(absPath);
};

const brokenLinks = [];
for (const file of walk('.')) {
  const dir = dirname(file);
  read(file)
    .split('\n')
    .forEach((line, i) => {
      // Any relative `.md` link — `./x.md`, `../x.md`, or `docs/x.md` without a
      // leading dot — with an optional `#anchor`. Absolute URLs are skipped.
      for (const m of line.matchAll(
        /\]\(((?![a-z][a-z0-9+.-]*:|\/)[^)#\s]*?\.md)(#[^)\s]*)?\)/gi
      )) {
        const target = join(ROOT, dir, m[1]);
        if (!existsSync(target)) {
          brokenLinks.push({ file: file.replace(/^\.\//, ''), line: i + 1, target: m[1] });
          continue;
        }
        if (m[2] && !anchorsOf(target).has(m[2].slice(1).toLowerCase())) {
          brokenLinks.push({
            file: file.replace(/^\.\//, ''),
            line: i + 1,
            target: `${m[1]}${m[2]} (no such heading)`,
          });
        }
      }
    });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const clean =
  brokenLinks.length === 0 &&
  missingGaps.length === 0 &&
  staleExemptions.length === 0 &&
  versionFailures.length === 0 &&
  proseFailures.length === 0 &&
  routeFailures.length === 0 &&
  pathFailures.length === 0 &&
  rosterFailures.length === 0 &&
  settingFailures.length === 0;

if (clean) {
  console.log(
    `Doc drift check passed — ${targets.length} living docs, ` +
      `${VERSIONED_DEPS.length} dependency versions, ${IMAGE_DEPS.length} image tags + Node, ` +
      'no broken links or anchors.'
  );
  console.log(
    `  ${gapCheckedDocs.length} docs state their limitations ` +
      `(${GAP_EXEMPT_DOCS.size} exempt: the index, runbooks, and the glossary).`
  );
  console.log(`  no forbidden status prose (${FORBIDDEN_PROSE.length} rules).`);
  console.log(`  every setting key named in prose resolves (${registeredKeyCount} registered).`);
  console.log(
    `  every dashboard route named in prose exists (${appRoutes.size} rendered, ` +
      `${legacyRedirects.length} old addresses refused).`
  );
  console.log('  every repository path named in prose exists.');
  console.log(`  the agent roster names all ${seededAgentKeys.length} seeded agents.`);
  process.exit(0);
}

if (staleExemptions.length > 0) {
  console.error(`Stale gap exemptions — ${staleExemptions.length} named doc(s) do not exist.\n`);
  for (const d of staleExemptions) {
    console.error(`  ${d}`);
  }
  console.error(
    '\nRemove it from GAP_EXEMPT_DOCS. Left behind, it silently exempts a future' +
      ' doc that reuses the name.\n'
  );
}

if (missingGaps.length > 0) {
  console.error(`Missing gap sections — ${missingGaps.length} doc(s).\n`);
  for (const d of missingGaps) {
    console.error(`  ${d}`);
  }
  console.error(
    '\nEvery capability doc states its own known gaps, so they stay next to the feature.'
  );
  console.error('Add a "## Limitations" section, or "Not built" if nothing else fits.\n');
}

if (rosterFailures.length > 0) {
  console.error(`Incomplete agent roster — ${rosterFailures.length} doc(s).\n`);
  for (const r of rosterFailures) {
    console.error(`  ${r.doc} does not name: ${r.keys.join(', ')}`);
  }
  console.error(
    '\n  source of truth: packages/shared/src/lib/syncBuiltins.ts\n' +
      '  A roster that lists most of the agents reads as though it lists them all.\n'
  );
}

if (pathFailures.length > 0) {
  console.error(`Stale repository paths — ${pathFailures.length} in the living docs.\n`);
  for (const p of pathFailures) {
    console.error(`  ${p.file}:${p.line}`);
    console.error(`    names ${p.path}, which does not exist`);
  }
  console.error('\n  Point at where the file lives now, or drop the reference.\n');
}

if (routeFailures.length > 0) {
  console.error(`Stale dashboard routes — ${routeFailures.length} in the living docs.\n`);
  for (const r of routeFailures) {
    console.error(`  ${r.file}:${r.line}`);
    console.error(
      r.movedTo
        ? `    names the old address ${r.path}; the page is now ${r.movedTo}`
        : `    names the page ${r.path}, which the dashboard does not serve`
    );
  }
  console.error('\n  source of truth: packages/web/src/app/**/page.tsx');
  console.error(
    '  Note that `/api/v1/admin/...` is still a live gateway prefix — an API path\n' +
      '  is not a page, and a line that mentions the API is skipped.\n'
  );
}

if (versionFailures.length > 0) {
  console.error(`Stale versions — ${versionFailures.length} in the living docs.\n`);
  for (const v of versionFailures) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    claims "${v.text}" but ${v.name} is ${v.actual}`);
    // The workspace image is the one claim NOT derived from a manifest — it
    // comes from the resolver the worker reads, and it tracks `.node-version`
    // only by coincidence.
    console.error(
      v.name === 'workspace image'
        ? '    source of truth: packages/shared/src/lib/systemConfig.ts (resolveWorkflowDefaults)\n'
        : '    source of truth: package.json / docker-compose.*.yml / .node-version\n'
    );
  }
  console.error('Bump the doc to match the manifest. A truncated version is fine when it is a');
  console.error('prefix of the real one ("Fastify 5.11" for 5.11.0).\n');
}

if (proseFailures.length > 0) {
  console.error(`Forbidden status prose — ${proseFailures.length} in the living docs.\n`);
  for (const p of proseFailures) {
    console.error(`  ${p.file}:${p.line}`);
    console.error(`    ${p.hint}: "${p.text}"\n`);
  }
  console.error('Living docs describe the system in present tense. Shipped status, phase labels,');
  console.error('PR numbers, and roadmap promises belong in git history and the pull request.');
  console.error('A promise nothing recompiles on is a promise that rots. Backticks and quotes are');
  console.error('stripped before matching, so the convention can still quote what it bans.\n');
}

if (settingFailures.length > 0) {
  console.error(`Unknown setting keys — ${settingFailures.length} in the living docs.\n`);
  for (const s of settingFailures) {
    console.error(`  ${s.file}:${s.line}`);
    console.error(`    names \`${s.token}\`, which the registry does not define`);
    console.error(`    did you mean: ${s.suggest}\n`);
  }
  console.error('A setting key is prefixed with its own group, so renaming the group renames the');
  console.error('key. Fix the doc, or the definition, so the two agree.');
  console.error('Source of truth: packages/shared/src/config/registry.ts\n');
}

if (brokenLinks.length > 0) {
  console.error(
    `Broken links — ${brokenLinks.length} relative .md link(s) point at nothing (or at no heading).\n`
  );
  for (const l of brokenLinks) {
    console.error(`  ${l.file}:${l.line} → ${l.target}`);
  }
  console.error('\nA moved doc breaks every link into it. Fix the path or restore the file.');
}

process.exit(1);
