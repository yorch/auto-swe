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
 * So this reads the source instead. It is a text heuristic, not a type checker —
 * see `HOISTED_WHERE` for what it deliberately cannot decide.
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

interface CallSite {
  id: string;
  location: string;
  /** Why it is safe, or null when nothing establishes that. */
  verdict: 'filtered' | 'marked' | 'hoisted' | null;
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
      const src = readFileSync(file, 'utf8');
      const exempt = [...src.matchAll(EXEMPT_WRAPPERS)].map((m) => {
        const open = (m.index ?? 0) + m[0].length - 1;
        return [open, closingIndex(src, open)] as const;
      });

      for (const m of src.matchAll(CALL)) {
        const at = m.index ?? 0;
        const rel = relative(REPO, file);
        const id = `${rel}:${m[1]}.${m[2]}`;
        const location = `${rel}:${src.slice(0, at).split('\n').length} ${m[1]}.${m[2]}`;

        if (exempt.some(([a, b]) => at > a && at < b)) {
          sites.push({ id, location, verdict: 'marked' });
          continue;
        }
        const args = src.slice(at + m[0].length - 1, closingIndex(src, at + m[0].length - 1));
        const whereAt = args.search(/\bwhere\s*:/);
        const brace = whereAt === -1 ? -1 : args.indexOf('{', whereAt);
        // Anything between `where:` and the brace means the value is not an
        // object literal (a variable, a call, a ternary).
        const inline = brace !== -1 && !/[^\s:a-z]/.test(args.slice(whereAt, brace));
        if (whereAt !== -1 && !inline) {
          sites.push({ id, location, verdict: HOISTED_WHERE.has(id) ? 'hoisted' : null });
          continue;
        }
        const where = inline ? args.slice(brace, closingIndex(args, brace)) : '';
        const filtered = TENANT_KEYS.some((k) => new RegExp(`\\b${k}\\b`).test(where));
        sites.push({ id, location, verdict: filtered ? 'filtered' : null });
      }
    }
  }
  return sites;
}

describe('tenant-scoped mass queries are filtered or marked', () => {
  const sites = scan();

  it('finds the call sites (the scanner itself works)', () => {
    // Without this the assertion below passes vacuously the moment the regex,
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

  it('keeps the hand-verified exceptions honest', () => {
    // A stale entry is as bad as a missing one: it reads as "checked" while the
    // call site it named is gone.
    const hoisted = new Set(sites.filter((s) => s.verdict === 'hoisted').map((s) => s.id));
    expect([...HOISTED_WHERE].filter((id) => !hoisted.has(id))).toEqual([]);
  });
});
