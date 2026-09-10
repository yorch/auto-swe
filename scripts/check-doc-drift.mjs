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
    // A model is a table, and the deployment runbook counts them that way — the
    // same fact stated in the other vocabulary, and it drifted precisely because
    // only one spelling was checked.
    patterns: [new RegExp(`${NUM}\\s+(?:Prisma\\s+)?(?:models|tables)\\b`, 'gi')],
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
/** Default tag of `<image>` in the compose files — `${VAR:-tag}` or a literal tag. */
const imageTag = (image) => {
  const m = composeSrc.match(
    new RegExp(`image:\\s*${image.replace(/[./]/g, '\\$&')}:(?:\\$\\{[A-Z_]+:-([^}]+)\\}|(\\S+))`)
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
  const m = src.match(/workspaceImage:\s*row\?\.workspaceImage\s*\?\?\s*'node:(\d+)-alpine'/);
  if (!m) {
    throw new Error(
      'could not find the workspaceImage default in packages/shared/src/lib/systemConfig.ts — ' +
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

const failures = [];

for (const file of targets) {
  const lines = read(file).split('\n');
  lines.forEach((line, i) => {
    checkVersions(relative('.', file), line, i + 1);
    checkImageVersions(relative('.', file), line, i + 1);
    checkProse(relative('.', file), line, i + 1);
    checkSettingKeys(relative('.', file), line, i + 1);
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
  proseFailures.length === 0 &&
  settingFailures.length === 0;

if (clean) {
  console.log(
    `Doc drift check passed — ${targets.length} living docs, ${CHECKS.length} facts, ` +
      `${VERSIONED_DEPS.length} dependency versions, ${IMAGE_DEPS.length} image tags + Node, ` +
      'no broken links or anchors.'
  );
  console.log(
    `  ${gapCheckedDocs.length} docs state their limitations ` +
      `(${GAP_EXEMPT_DOCS.size} runbooks exempt).`
  );
  console.log(`  no forbidden status prose (${FORBIDDEN_PROSE.length} rules).`);
  console.log(`  every setting key named in prose resolves (${settingKeys.size} registered).`);
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
