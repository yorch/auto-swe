import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';
import { describe, expect, it } from 'vitest';
import { delegateName, modelName } from '../prisma/schemaModels.js';
import { GUARDED_OPERATIONS, hasTenantPredicate, TENANT_SCOPED_MODELS } from './tenantGuard.js';

/**
 * Every mass query on a tenant-scoped model is either filtered or marked.
 *
 * `tenantGuard` already enforces this at run time, but only on a path some test
 * actually walks with a real client — and route tests decorate a mocked Prisma,
 * so the extension never runs. In production the guard now defaults to `'throw'`,
 * the first symptom of a forgotten filter is a thrown error during tests or at runtime. Hand
 * triage does not close that: it was done twice on the gateway and missed seven
 * call sites both times.
 *
 * So this reads the source instead — through the TypeScript parser, and then
 * through the guard's own {@link hasTenantPredicate}. Both halves matter. An
 * earlier text-matching version had to hand-roll string/comment stripping and
 * bracket matching, and graded a `where` by whether a tenant key appeared
 * anywhere in it — which blessed `NOT: { teamId }`, `{ teamId: { not } }` and
 * `{ channelId: null }`, the exact shapes the runtime guard rejects. Reusing the
 * real predicate makes the audit and the guard agree by construction.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PACKAGES = ['gateway', 'worker', 'shared', 'web', 'cli', 'sdk'];

/** Wrappers that declare a query intentionally cross-tenant. */
const EXEMPT_WRAPPERS = new Set(['runUnscoped', 'asPlatformAdmin']);

/**
 * Call sites whose `where` is not an object literal here — a variable, a helper
 * call, or one built from caller-supplied filters — so whether they scope is a
 * property of something this file cannot see. Each is verified by hand:
 *
 *  - `agentLibraryService:agent.updateMany` → `scopeWhere()`, which always sets
 *    `teamId`/`orgId`/`channelId`.
 *  - `skills:skill.findMany` → `skillVisibilityWhere()`, an `OR` over the team's
 *    and org's rows plus the GLOBAL ones.
 *  - `agentLibraryService:agent.findMany` → `listAgents`'s all-optional filter.
 *    Its two callers are checked: the admin library route marks the call with
 *    `runUnscoped(['Agent'])`, the per-team route passes `{ scope: 'TEAM', teamId }`.
 *
 * Keep this list short. A new entry means someone put a `where` behind an
 * indirection that can no longer be read off the page — inline it, or mark the
 * call, before adding it here. The runtime guard still covers every one of them.
 *
 * **The count is load-bearing.** Keyed on file + delegate + operation alone, one
 * blessed `agent.findMany` would bless every other `agent.findMany` in the same
 * file — an allowlist that widens with no one editing it, which is the one way
 * it can rot that reading it cannot catch. A line number would be unique but
 * churns on every edit above it, so the entry declares how many call sites it
 * covers instead: adding one fails here until someone raises the number, and
 * raising it is the moment they have to look at the new query.
 */
const HAND_VERIFIED = new Map([
  ['packages/gateway/src/lib/agentLibraryService.ts:agent.findMany', 1],
  ['packages/gateway/src/lib/agentLibraryService.ts:agent.updateMany', 1],
  ['packages/gateway/src/routes/humanErrorBaselines.ts:humanErrorBaseline.findMany', 1],
  ['packages/gateway/src/routes/skills.ts:skill.findMany', 1],
]);

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

const DELEGATES = new Map([...TENANT_SCOPED_MODELS].map((m) => [delegateName(m), m]));

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

function* walk(node: ts.Node): Generator<ts.Node> {
  yield node;
  for (const child of node.getChildren()) {
    yield* walk(child);
  }
}

/**
 * Rebuilds a `where` object literal as plain data for {@link hasTenantPredicate}.
 *
 * Values are placeholders — the predicate only cares about *shape*: which keys
 * are present, whether a value is null, and whether it nests a negating
 * operator. Spreads are dropped rather than guessed at, so
 * `{ ...(filter.teamId && { teamId }) }` reads as the `{}` it is when the caller
 * passes nothing.
 */
function literalToData(node: ts.Expression): unknown {
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        out[prop.name.text] = '?';
      } else if (ts.isPropertyAssignment(prop)) {
        const key =
          ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
        if (key !== null) {
          out[key] = literalToData(prop.initializer);
        }
      }
      // SpreadAssignment: conditional, so it contributes nothing.
    }
    return out;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.filter((e) => !ts.isSpreadElement(e)).map(literalToData);
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  // Any other expression is a non-null value as far as scoping is concerned.
  return '?';
}

/** `prisma.memoryItem.findMany` → `{ delegate, op }`, when it is one we guard. */
function guardedCall(call: ts.CallExpression): { delegate: string; op: string } | null {
  const fn = call.expression;
  if (!ts.isPropertyAccessExpression(fn) || !ts.isPropertyAccessExpression(fn.expression)) {
    return null;
  }
  const op = fn.name.text;
  const delegate = fn.expression.name.text;
  return GUARDED_OPERATIONS.has(op) && DELEGATES.has(delegate) ? { delegate, op } : null;
}

/** Model names in the array argument of a `runUnscoped`/`asPlatformAdmin` call. */
function exemptedModels(call: ts.CallExpression): Set<string> {
  const arr = call.arguments.find((a) => ts.isArrayLiteralExpression(a));
  if (!arr || !ts.isArrayLiteralExpression(arr)) {
    return new Set();
  }
  return new Set(arr.elements.filter(ts.isStringLiteral).map((e) => e.text));
}

interface CallSite {
  id: string;
  location: string;
  /** Why it is safe, or null when nothing establishes that. */
  verdict: 'filtered' | 'marked' | 'hand-verified' | null;
  /** Set when a wrapper covers the call but does not name its model. */
  unnamedModel?: string;
}

interface ScanResult {
  sites: CallSite[];
  /** Files building their own client, excluding the allowlist. */
  ownClients: string[];
  filesScanned: number;
}

function scan(): ScanResult {
  const sites: CallSite[] = [];
  const ownClients: string[] = [];
  let filesScanned = 0;

  for (const pkg of PACKAGES) {
    let files: string[];
    try {
      files = sourceFiles(join(REPO, 'packages', pkg, 'src'));
    } catch {
      continue; // package has no src/
    }
    for (const file of files) {
      filesScanned++;
      const rel = relative(REPO, file);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      const nodes = [...walk(source)];

      const exempt = nodes
        .filter(
          (n): n is ts.CallExpression =>
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            EXEMPT_WRAPPERS.has(n.expression.text)
        )
        .map((n) => ({ end: n.getEnd(), models: exemptedModels(n), start: n.getStart() }));

      for (const node of nodes) {
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'PrismaClient' &&
          !OWN_PRISMA_CLIENT.has(rel)
        ) {
          ownClients.push(rel);
        }
        if (!ts.isCallExpression(node)) {
          continue;
        }
        const guarded = guardedCall(node);
        if (!guarded) {
          continue;
        }
        const at = node.getStart();
        const line = source.getLineAndCharacterOfPosition(at).line + 1;
        const model = DELEGATES.get(guarded.delegate) as string;
        const id = `${rel}:${guarded.delegate}.${guarded.op}`;
        const location = `${rel}:${line} ${guarded.delegate}.${guarded.op}`;

        const region = exempt.find((r) => at > r.start && at < r.end);
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

        const arg = node.arguments[0];
        const where =
          arg && ts.isObjectLiteralExpression(arg)
            ? arg.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'where'
              )
            : undefined;
        if (where && !ts.isObjectLiteralExpression(where.initializer)) {
          sites.push({ id, location, verdict: HAND_VERIFIED.has(id) ? 'hand-verified' : null });
          continue;
        }
        // The guard's own predicate, on the shape the guard would see.
        const filtered = hasTenantPredicate(where ? literalToData(where.initializer) : undefined);
        sites.push({
          id,
          location,
          verdict: filtered ? 'filtered' : HAND_VERIFIED.has(id) ? 'hand-verified' : null,
        });
      }
    }
  }
  return { filesScanned, ownClients, sites };
}

// One pass over the tree, shared by both suites below.
const { filesScanned, ownClients, sites } = scan();

describe('tenant-scoped mass queries are filtered or marked', () => {
  it('finds the call sites (the scanner itself works)', () => {
    // Without this the assertions below pass vacuously the moment the parser,
    // the package list, or the delegate naming convention drifts.
    expect(filesScanned).toBeGreaterThan(200);
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
    // call site it named is gone. And an entry covering fewer sites than exist
    // is worse than either — the extra ones were never verified by anyone.
    const counted = new Map<string, number>();
    for (const site of sites) {
      if (site.verdict === 'hand-verified') {
        counted.set(site.id, (counted.get(site.id) ?? 0) + 1);
      }
    }
    const wrong = [...HAND_VERIFIED].flatMap(([id, expected]) => {
      const actual = counted.get(id) ?? 0;
      if (actual === expected) {
        return [];
      }
      return actual === 0
        ? [`${id} — no such call site any more; drop the entry`]
        : [`${id} — entry covers ${expected} call site(s), found ${actual}`];
    });
    expect(wrong).toEqual([]);
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
    expect(ownClients, 'use the shared `prisma` singleton — it carries the guard').toEqual([]);
  });
});

describe('delegate naming', () => {
  it('round-trips every tenant-scoped model', () => {
    // `DELEGATES` above, and `keyRotation`'s exemption, both depend on this.
    for (const model of TENANT_SCOPED_MODELS) {
      expect(modelName(delegateName(model))).toBe(model);
    }
  });
});
