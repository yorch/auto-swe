import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TENANT_SCOPED_MODELS } from './tenantGuard.js';

/**
 * Every mass query on a tenant-scoped model is either filtered or marked.
 *
 * `tenantGuard` already enforces this at run time, but only on a path some test
 * actually walks with a real client — and route tests decorate a mocked Prisma,
 * so the extension never runs. In production the guard defaults to `'warn'`, so
 * the first symptom of a forgotten filter is a log line nobody reads. Hand
 * triage does not close that: it was done twice on the gateway and missed seven
 * call sites both times.
 *
 * So this reads the source instead. Source text is not a type system, so the
 * scanner strips strings and comments before matching (an unbalanced brace in
 * either would otherwise silently extend a region and grade whatever follows as
 * accounted for) and only trusts a `where` it can see as an inline literal —
 * see `HOISTED_WHERE`.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PACKAGES = ['gateway', 'worker', 'shared', 'web', 'cli', 'sdk'];

/** Mass operations — the same set `tenantGuard` intercepts. */
const OPS = ['findMany', 'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany'];

/** Keys `hasTenantPredicate` accepts, as they appear in source. */
const TENANT_KEYS = [
  'teamId',
  'orgId',
  'organizationId',
  'organization',
  'team',
  'memberships',
  'channelId',
];

/** Wrappers that declare a query intentionally cross-tenant. */
const EXEMPT_WRAPPERS = /\b(runUnscoped|asPlatformAdmin)\s*\(/g;

/**
 * Call sites whose `where` is a variable or helper call, which this check
 * cannot read. Each is verified by hand to scope through the value it is given:
 *
 *  - `agentLibraryService` → `scopeWhere()`, which always sets `teamId`/`orgId`.
 *  - `skills` → `skillVisibilityWhere()`, which returns an `OR` over the team's
 *    and org's rows plus the GLOBAL ones.
 *
 * Keep this list short. A new entry means someone hid a `where` behind an
 * indirection the guard can no longer be read off the page — inline it, or mark
 * the call, before adding it here.
 */
const HOISTED_WHERE = new Set([
  'packages/gateway/src/lib/agentLibraryService.ts:agent.updateMany',
  'packages/gateway/src/routes/skills.ts:skill.findMany',
]);

/**
 * Call sites whose `where` is built entirely from caller-supplied filters, so
 * whether they scope is a property of the callers, not of this line.
 *
 * `listAgents` takes an all-optional `filter` and spreads each key in only when
 * set — with nothing set the `where` is `{}`. Its two callers are checked by
 * hand: the admin library route marks the call with `runUnscoped(['Agent'])`,
 * and the per-team route passes `{ scope: 'TEAM', teamId }`. The runtime guard
 * still covers both; this only records that the *static* check cannot.
 */
const CALLER_SCOPED = new Set(['packages/gateway/src/lib/agentLibraryService.ts:agent.findMany']);

/**
 * Files allowed to build their own `PrismaClient`.
 *
 * Everything else must use the shared singleton, because that is the one place
 * the guard is attached. A second client is unguarded — which is exactly how
 * the gateway lost its guard once already.
 */
const OWN_PRISMA_CLIENT = new Set([
  // The factory that attaches the guard.
  'packages/shared/src/db.ts',
  // better-auth drives its own user/session/account tables, none of which are
  // tenant-scoped, through an adapter that wants an unextended client.
  'packages/gateway/src/lib/betterAuth.ts',
  // Seeding writes GLOBAL rows across every tenant by definition.
  'packages/shared/src/prisma/seed.ts',
]);

const DELEGATES = new Map(
  [...TENANT_SCOPED_MODELS].map((m) => [m[0].toLowerCase() + m.slice(1), m])
);

const CALL = new RegExp(
  `\\b\\w+\\.(${[...DELEGATES.keys()].join('|')})\\.(${OPS.join('|')})\\s*\\(`,
  'g'
);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // `generated/` is the Prisma client itself — it names every delegate.
      if (entry !== 'generated' && entry !== 'node_modules') {
        sourceFiles(path, out);
      }
    } else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Replaces every string literal and comment with spaces, preserving length so
 * all indices still line up with the original source.
 *
 * Without this a `)` inside a comment or a `'}'` inside a string throws the
 * bracket matching off, and the dangerous direction is silent: an over-long
 * exempt region grades every query after it as marked.
 */
function blankLiterals(src: string): string {
  const out = src.split('');
  let i = 0;
  const blankTo = (end: number) => {
    for (; i < end && i < out.length; i++) {
      if (out[i] !== '\n') {
        out[i] = ' ';
      }
    }
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      blankTo(nl === -1 ? src.length : nl);
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      blankTo(end === -1 ? src.length : end + 2);
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        j += src[j] === '\\' ? 2 : 1;
      }
      blankTo(Math.min(j + 1, src.length));
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Index just past the bracket closing the one opened at `open`. */
function closingIndex(src: string, open: number): number {
  const close = src[open] === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) {
      depth++;
    } else if (src[i] === close && --depth === 0) {
      return i + 1;
    }
  }
  return src.length;
}

/**
 * The `where:` belonging to `args` itself, skipping the ones nested inside
 * `select`/`include` relation filters.
 *
 * Three call sites select `team: { memberships: { where: { userId } } }`, whose
 * `where` appears in the text first. Reading that one instead of the real one
 * disagrees with the runtime guard, which only ever inspects `args.where`.
 */
function topLevelWhere(args: string): { at: number; brace: number } | null {
  // `args` starts at the call's `(`, so the argument object's own keys sit at
  // depth 2: one for the paren, one for the object literal.
  const TOP = 2;
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '{' || c === '(' || c === '[') {
      depth++;
    } else if (c === '}' || c === ')' || c === ']') {
      depth--;
    } else if (depth === TOP && args.startsWith('where', i) && /^\s*:/.test(args.slice(i + 5))) {
      return { at: i, brace: args.indexOf('{', i) };
    }
  }
  return null;
}

/**
 * Blanks out `...(cond && { … })` spread groups.
 *
 * `{ ...(filter.teamId && { teamId: filter.teamId }) }` mentions `teamId` but
 * resolves to `{}` when the caller passes nothing — an unfiltered read of every
 * tenant that a plain text match grades as filtered.
 */
function blankConditionalSpreads(where: string): string {
  let out = where;
  for (;;) {
    const at = out.indexOf('...(');
    if (at === -1) {
      return out;
    }
    const end = closingIndex(out, at + 3);
    out = out.slice(0, at) + ' '.repeat(end - at) + out.slice(end);
  }
}

/**
 * Model names listed by the `runUnscoped`/`asPlatformAdmin` call opening at `open`.
 *
 * Bracket matching runs on `blanked` (so a bracket inside a string cannot throw
 * it off) but the names are read back out of `raw` — blanking removed them.
 * The two are index-aligned by construction.
 */
function exemptedModels(raw: string, blanked: string, open: number): Set<string> {
  const end = closingIndex(blanked, open);
  const bracket = blanked.indexOf('[', open);
  if (bracket === -1 || bracket > end) {
    return new Set();
  }
  const list = raw.slice(bracket, closingIndex(blanked, bracket));
  return new Set([...list.matchAll(/'([A-Z]\w*)'/g)].map((m) => m[1]));
}

interface CallSite {
  id: string;
  location: string;
  /** Why it is safe, or null when nothing establishes that. */
  verdict: 'filtered' | 'marked' | 'hoisted' | 'caller-scoped' | null;
  /** Set when a wrapper covers the call but does not name its model. */
  unnamedModel?: string;
}

function scan(): CallSite[] {
  const sites: CallSite[] = [];
  for (const pkg of PACKAGES) {
    let files: string[];
    try {
      files = sourceFiles(join(REPO, 'packages', pkg, 'src'));
    } catch {
      continue; // package has no src/
    }
    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      const src = blankLiterals(raw);
      const exempt = [...src.matchAll(EXEMPT_WRAPPERS)].map((m) => {
        const open = (m.index ?? 0) + m[0].length - 1;
        return { end: closingIndex(src, open), models: exemptedModels(raw, src, open), open };
      });

      for (const m of src.matchAll(CALL)) {
        const at = m.index ?? 0;
        const rel = relative(REPO, file);
        const model = DELEGATES.get(m[1]) as string;
        const id = `${rel}:${m[1]}.${m[2]}`;
        const location = `${rel}:${src.slice(0, at).split('\n').length} ${m[1]}.${m[2]}`;

        const region = exempt.find((r) => at > r.open && at < r.end);
        if (region) {
          // A wrapper that names the wrong models exempts nothing at run time,
          // but reads as accounted for here. Check what it actually named.
          sites.push({
            id,
            location,
            unnamedModel: region.models.has(model) ? undefined : model,
            verdict: 'marked',
          });
          continue;
        }
        const args = src.slice(at + m[0].length - 1, closingIndex(src, at + m[0].length - 1));
        const found = topLevelWhere(args);
        // Anything between `where:` and the brace means the value is not an
        // object literal (a variable, a call, a ternary).
        const inline =
          found !== null &&
          found.brace !== -1 &&
          !/[^\s:]/.test(args.slice(found.at + 5, found.brace));
        if (found !== null && !inline) {
          sites.push({ id, location, verdict: HOISTED_WHERE.has(id) ? 'hoisted' : null });
          continue;
        }
        const where =
          inline && found
            ? blankConditionalSpreads(args.slice(found.brace, closingIndex(args, found.brace)))
            : '';
        const filtered = TENANT_KEYS.some((k) => new RegExp(`\\b${k}\\b`).test(where));
        sites.push({
          id,
          location,
          verdict: filtered ? 'filtered' : CALLER_SCOPED.has(id) ? 'caller-scoped' : null,
        });
      }
    }
  }
  return sites;
}

describe('tenant-scoped mass queries are filtered or marked', () => {
  const sites = scan();

  it('finds the call sites (the scanner itself works)', () => {
    // Without this the assertions below pass vacuously the moment the regex,
    // the package list, or the delegate naming convention drifts.
    expect(sites.length).toBeGreaterThan(40);
    expect(sites.filter((s) => s.verdict === 'marked').length).toBeGreaterThan(10);
    expect(sites.filter((s) => s.verdict === 'filtered').length).toBeGreaterThan(10);
  });

  it('leaves none unaccounted for', () => {
    const unaccounted = sites.filter((s) => s.verdict === null).map((s) => s.location);
    expect(
      unaccounted,
      'add the tenant filter, or wrap the call in runUnscoped()/asPlatformAdmin()'
    ).toEqual([]);
  });

  it('exempts each query for the model it actually queries', () => {
    // `runUnscoped('…', ['Connection'], () => prisma.memoryItem.findMany(…))`
    // reads as marked but exempts nothing — the guard still throws on
    // MemoryItem. Catch the mismatch here rather than in production.
    const mismatched = sites
      .filter((s) => s.unnamedModel)
      .map((s) => `${s.location} — wrapper does not name ${s.unnamedModel}`);
    expect(mismatched).toEqual([]);
  });

  it('keeps the hand-verified exceptions honest', () => {
    // A stale entry is as bad as a missing one: it reads as "checked" while the
    // call site it named is gone.
    const seen = new Set(
      sites.filter((s) => s.verdict === 'hoisted' || s.verdict === 'caller-scoped').map((s) => s.id)
    );
    expect([...HOISTED_WHERE, ...CALLER_SCOPED].filter((id) => !seen.has(id))).toEqual([]);
  });
});

describe('the guard is attached where it is claimed to be', () => {
  it('is applied by the shared client factory', () => {
    const db = readFileSync(join(REPO, 'packages/shared/src/db.ts'), 'utf8');
    expect(db).toMatch(/\$extends\(\s*tenantGuardExtension\(/);
  });

  it('is not bypassed by a second PrismaClient', () => {
    // The regression this catches: the gateway plugin built its own client, so
    // `fastify.prisma` — the client ~30 route files use — was unguarded while
    // the docs said otherwise.
    const offenders: string[] = [];
    for (const pkg of PACKAGES) {
      let files: string[];
      try {
        files = sourceFiles(join(REPO, 'packages', pkg, 'src'));
      } catch {
        continue;
      }
      for (const file of files) {
        const rel = relative(REPO, file);
        if (OWN_PRISMA_CLIENT.has(rel)) {
          continue;
        }
        if (/new PrismaClient\s*\(/.test(blankLiterals(readFileSync(file, 'utf8')))) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders, 'use the shared `prisma` singleton — it carries the guard').toEqual([]);
  });
});
