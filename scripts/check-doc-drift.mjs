#!/usr/bin/env node
/**
 * Documentation drift check.
 *
 * The living docs make a handful of *countable* claims about the system ("15 node
 * types", "51 Prisma models", "28 built-in skills"). Prose has no compiler, so those
 * numbers silently rot every time the schema or the spec changes — this script is the
 * compiler. It derives each fact from source, then fails if any living doc states a
 * different number.
 *
 * Scope is deliberately narrow: only claims that can be derived unambiguously from a
 * single source of truth. Frozen docs under `docs/history/` are never checked — they are
 * point-in-time records and are *supposed* to state the numbers that were true then.
 *
 * Run: `yarn docs:check`
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Docs may spell small counts as words.
const WORD_NUMBERS = {
  eight: 8,
  eleven: 11,
  five: 5,
  four: 4,
  nine: 9,
  seven: 7,
  six: 6,
  ten: 10,
  three: 3,
  twelve: 12,
  two: 2,
};
const toNumber = (raw) => WORD_NUMBERS[raw.toLowerCase()] ?? Number(raw);

/**
 * A counted quantity. The lookbehind rejects a digit that is really part of a
 * section number or a decimal — `### 6.2 Built-in Skills` must not read as "2".
 */
const NUM = '(?<![\\w.])(\\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

// ---------------------------------------------------------------------------
// Facts derived from source
// ---------------------------------------------------------------------------

const specSrc = read('packages/shared/src/workflow/spec.ts');
const schemaSrc = read('packages/shared/src/prisma/schema.prisma');
const skillsSrc = read('packages/shared/src/skills/index.ts');
const patternsSrc = read('packages/shared/src/scannerPatterns/index.ts');
const agentKeysSrc = read('packages/shared/src/agentKeys.ts');
const stepRegistrySrc = read('packages/shared/src/workflow/stepRegistry.ts');

const count = (src, re) => (src.match(re) ?? []).length;

/** Members of the `NodeSchema` discriminated union. */
const nodeTypes = count(specSrc, /^\s*type: z\.literal\('[a-zA-Z]+'\),$/gm);

/** `model X {` declarations in the Prisma schema. */
const prismaModels = count(schemaSrc, /^model /gm);

/** Entries of the `BUILTIN_SKILLS` array. */
const builtinSkills = (() => {
  const body = skillsSrc.match(/BUILTIN_SKILLS: BuiltinSkillDef\[\] = \[([\s\S]*?)^\];/m);
  if (!body) {
    throw new Error('could not locate BUILTIN_SKILLS array');
  }
  return count(body[1], /^\s*[A-Z0-9_]+_SKILL,$/gm);
})();

/**
 * Built-in scanner patterns, total and per `ScannerPatternType`.
 *
 * The trailing comma is load-bearing: `BuiltinScannerPatternDef` declares
 * `type: 'INJECTION' | 'EXFILTRATION' | …;`, and matching without it counted
 * that union as a 14th INJECTION pattern — inflating every total by one.
 * Verified against a seeded database: 58 rows, 13 INJECTION.
 */
const patternsByType = {};
for (const m of patternsSrc.matchAll(/type: '([A-Z_]+)',/g)) {
  patternsByType[m[1]] = (patternsByType[m[1]] ?? 0) + 1;
}
const scannerPatterns = Object.values(patternsByType).reduce((a, b) => a + b, 0);

/** Entries of `MODEL_BACKED_AGENT_KEYS` — the narrow convenience set, not the agent universe. */
const modelBackedAgentKeys = (() => {
  const body = agentKeysSrc.match(/MODEL_BACKED_AGENT_KEYS = \[([\s\S]*?)\] as const;/);
  if (!body) {
    throw new Error('could not locate MODEL_BACKED_AGENT_KEYS array');
  }
  return count(body[1], /^\s*'[a-zA-Z]+',$/gm);
})();

/**
 * Seeded built-in agents, split by how they bind a model. An agent carries either its
 * own `modelSpec` (model-backed) or an `inheritsModelFrom` pointer (sub-role persona).
 */
const builtinAgentsSrc = read('packages/shared/src/lib/syncBuiltins.ts');
const modelBackedAgents = count(builtinAgentsSrc, /^\s*modelSpec: '/gm);
const subRoleAgents = count(builtinAgentsSrc, /^\s*inheritsModelFrom: '/gm);
const builtinAgents = modelBackedAgents + subRoleAgents;

/** Entries of `IMPLEMENTER_TOOL_IDS` (the configurable workspace tools). */
const implementerTools = (() => {
  const body = stepRegistrySrc.match(/IMPLEMENTER_TOOL_IDS = \[([^\]]*)\]/);
  if (!body) {
    throw new Error('could not locate IMPLEMENTER_TOOL_IDS array');
  }
  return count(body[1], /'[a-zA-Z]+'/g);
})();

// ---------------------------------------------------------------------------
// Claims to verify in the living docs
// ---------------------------------------------------------------------------

const CHECKS = [
  {
    actual: nodeTypes,
    label: 'workflow node types',
    patterns: [new RegExp(`${NUM}\\s+node types`, 'gi')],
    // The four HITL node types are a legitimate subset, not a claim about the total.
    skipLine: /HITL|human/i,
    source: 'packages/shared/src/workflow/spec.ts (NodeSchema union)',
  },
  {
    actual: prismaModels,
    label: 'Prisma models',
    patterns: [new RegExp(`${NUM}\\s+(?:Prisma\\s+)?models\\b`, 'gi')],
    source: 'packages/shared/src/prisma/schema.prisma',
  },
  {
    actual: builtinSkills,
    label: 'built-in skills',
    patterns: [
      // Tolerates qualifiers between the two words: "27 built-in prompt-fragment skills".
      new RegExp(`${NUM}\\s+built-in(?:\\s+[a-z-]+){0,3}\\s+skills`, 'gi'),
      new RegExp(`built-in skills \\(${NUM} total\\)`, 'gi'),
    ],
    source: 'packages/shared/src/skills/index.ts (BUILTIN_SKILLS)',
  },
  {
    actual: scannerPatterns,
    label: 'built-in scanner patterns',
    patterns: [
      new RegExp(`${NUM}\\s+built-in (?:scanner )?patterns`, 'gi'),
      new RegExp(`${NUM}\\s+patterns (?:in|across)`, 'gi'),
      new RegExp(`(?:total(?:ling)?|totals?)\\s+\\*{0,2}${NUM}\\*{0,2}`, 'gi'),
    ],
    source: 'packages/shared/src/scannerPatterns/index.ts',
  },
  {
    actual: builtinAgents,
    label: 'seeded built-in agents',
    patterns: [
      new RegExp(`${NUM}\\s+(?:seeded\\s+)?built-in agents`, 'gi'),
      new RegExp(`${NUM}\\s+agent roles`, 'gi'),
    ],
    source: 'packages/shared/src/lib/syncBuiltins.ts',
  },
  {
    actual: modelBackedAgents,
    label: 'model-backed built-in agents (own modelSpec)',
    patterns: [new RegExp(`${NUM}\\s+model-backed`, 'gi')],
    source: 'packages/shared/src/lib/syncBuiltins.ts (entries with modelSpec)',
  },
  {
    actual: subRoleAgents,
    label: 'sub-role built-in agents (inheritsModelFrom)',
    patterns: [new RegExp(`${NUM}\\s+sub-role`, 'gi')],
    source: 'packages/shared/src/lib/syncBuiltins.ts (entries with inheritsModelFrom)',
  },
  {
    actual: modelBackedAgentKeys,
    label: 'MODEL_BACKED_AGENT_KEYS entries',
    patterns: [new RegExp(`MODEL_BACKED_AGENT_KEYS[^.\\n]*?\\(${NUM}\\)`, 'g')],
    source: 'packages/shared/src/agentKeys.ts (MODEL_BACKED_AGENT_KEYS)',
  },
  {
    actual: implementerTools,
    label: 'configurable implementer workspace tools',
    patterns: [new RegExp(`${NUM}\\s+configurable workspace tools`, 'gi')],
    source: 'packages/shared/src/workflow/stepRegistry.ts (IMPLEMENTER_TOOL_IDS)',
  },
  ...Object.entries(patternsByType).map(([type, n]) => ({
    actual: n,
    label: `${type} scanner patterns`,
    patterns: [new RegExp(`${NUM}\\s+\\*{0,2}\`?${type}\`?\\*{0,2}`, 'g')],
    source: 'packages/shared/src/scannerPatterns/index.ts',
  })),
];

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
/** Highest-precedence declared version for a dependency, across all workspaces. */
const MANIFESTS = [
  'package.json',
  ...readdirSync(join(ROOT, 'packages')).map((d) => `packages/${d}/package.json`),
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
const isVersionPrefix = (claimed, actual) =>
  actual === claimed || actual.startsWith(`${claimed}.`);

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
  {
    actual: depVersion('@temporalio/worker'),
    name: '@temporalio SDK',
    // Never bare "Temporal" — that is the server image, on its own release train.
    pattern: '@temporalio(?:/[\\w{},*-]+)?(?: SDK)?',
  },
];

const VERSION = '(\\d+(?:\\.\\d+)*)';

/** Every version-looking token in a string, e.g. "16.2.7 / 19.2.7" → both. */
const versionsIn = (cell) => (cell.match(/\d+(?:\.\d+)*/g) ?? []);

const versionFailures = [];
const checkVersions = (file, line, lineNo) => {
  for (const dep of VERSIONED_DEPS) {
    const inline = new RegExp(`\\b${dep.pattern}\\s+v?${VERSION}`, 'gi');
    // A trailing table cell: "| Fastify | 5.11.0 |".
    const cell = new RegExp(
      `\\|[^|\\n]*?\\b${dep.pattern}\\b[^|\\n]*\\|\\s*(v?\\d[\\d./\\s]*?)\\s*\\|`,
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
const targets = [
  'AGENTS.md',
  'README.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('docs', f)),
];

const failures = [];

for (const file of targets) {
  const lines = read(file).split('\n');
  lines.forEach((line, i) => {
    checkVersions(relative('.', file), line, i + 1);
    checkProse(relative('.', file), line, i + 1);
    for (const check of CHECKS) {
      if (check.skipLine?.test(line)) {
        continue;
      }
      for (const pattern of check.patterns) {
        pattern.lastIndex = 0;
        for (const match of line.matchAll(pattern)) {
          const claimed = toNumber(match[1]);
          if (Number.isNaN(claimed) || claimed === check.actual) {
            continue;
          }
          failures.push({
            actual: check.actual,
            claimed,
            file: relative('.', file),
            label: check.label,
            line: i + 1,
            source: check.source,
            text: match[0].trim(),
          });
        }
      }
    }
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
// Only pure procedure belongs here. A runbook tells you which buttons to press;
// it makes no claim about what the system can do, so it has no gaps to state.
// ---------------------------------------------------------------------------

const GAP_EXEMPT_DOCS = new Set([
  'docs/README.md', // index
  'docs/deployment.md', // runbook
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
// Broken relative links
//
// Moving a doc silently breaks every link into it. Unlike the counts above this
// scans the whole tree, frozen docs included — a dead link is wrong everywhere.
// ---------------------------------------------------------------------------

/**
 * Build output copies the docs to a different depth, so their relative links
 * legitimately do not resolve there. Skipping these mirrors `biome.json`'s
 * ignore list — without it the check passes in CI (which runs before any build)
 * and fails for anyone who runs it after one.
 */
const SKIP_DIRS = new Set([
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

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(p));
    } else if (entry.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
};

const brokenLinks = [];
for (const file of walk('.')) {
  const dir = dirname(file);
  read(file)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/\]\((\.[^)#\s]*?\.md)(#[^)]*)?\)/g)) {
        const target = join(ROOT, dir, m[1]);
        if (!existsSync(target)) {
          brokenLinks.push({ file: file.replace(/^\.\//, ''), line: i + 1, target: m[1] });
        }
      }
    });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const facts = [
  ['workflow node types', nodeTypes],
  ['Prisma models', prismaModels],
  ['built-in skills', builtinSkills],
  ['built-in scanner patterns', scannerPatterns],
  ['seeded built-in agents', builtinAgents],
  ['  … model-backed', modelBackedAgents],
  ['  … sub-role personas', subRoleAgents],
  ['implementer workspace tools', implementerTools],
];

const clean =
  failures.length === 0 &&
  brokenLinks.length === 0 &&
  missingGaps.length === 0 &&
  staleExemptions.length === 0 &&
  versionFailures.length === 0 &&
  proseFailures.length === 0;

if (clean) {
  console.log(
    `Doc drift check passed — ${targets.length} living docs, ${CHECKS.length} facts, ` +
      `${VERSIONED_DEPS.length} dependency versions, no broken links.`
  );
  console.log(
    `  ${gapCheckedDocs.length} docs state their limitations ` +
      `(${GAP_EXEMPT_DOCS.size} runbooks exempt).`
  );
  console.log(`  no forbidden status prose (${FORBIDDEN_PROSE.length} rules).`);
  for (const [label, value] of facts) {
    console.log(`  ${String(value).padStart(3)}  ${label}`);
  }
  process.exit(0);
}

if (failures.length > 0) {
  console.error(`Stale claims — ${failures.length} in the living docs.\n`);
  for (const f of failures) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    claims "${f.text}" but there are ${f.actual} ${f.label}`);
    console.error(`    source of truth: ${f.source}\n`);
  }
  console.error('Update the doc, or the source, so the two agree.');
  console.error('Frozen docs under docs/history/ are exempt from claim checks.\n');
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

if (versionFailures.length > 0) {
  console.error(`Stale versions — ${versionFailures.length} in the living docs.\n`);
  for (const v of versionFailures) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    claims "${v.text}" but ${v.name} is ${v.actual}`);
    console.error('    source of truth: package.json\n');
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

if (brokenLinks.length > 0) {
  console.error(`Broken links — ${brokenLinks.length} relative .md link(s) point at nothing.\n`);
  for (const l of brokenLinks) {
    console.error(`  ${l.file}:${l.line} → ${l.target}`);
  }
  console.error('\nA moved doc breaks every link into it. Fix the path or restore the file.');
}

process.exit(1);
