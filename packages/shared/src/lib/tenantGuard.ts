import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Fails a multi-row query on a tenant-scoped model that carries no tenant
 * predicate.
 *
 * Org and team membership is checked on the routes, so a handler that forgets
 * its filter is a data-exposure bug that nothing else catches — the database has
 * no row-level policies, and a reviewer has to notice the absence of a line.
 * This makes the absence loud instead.
 *
 * **Scope: mass operations only** — `findMany`, `count`, `aggregate`,
 * `groupBy`, `updateMany`, `deleteMany`. Those are the ones where a missing
 * filter reads or mutates every tenant at once. A `findUnique`/`findFirst` by
 * id is deliberately not guarded: it is the normal fetch-then-check shape, it
 * leaks at most one row, and requiring a predicate there would mean rewriting
 * every ownership check in the codebase for a much smaller win.
 *
 * This is defence in depth at the ORM layer, not a security boundary. Raw SQL
 * bypasses it entirely, as does any query that reaches Postgres another way.
 * Real isolation is row-level security, which this does not replace.
 */

/** Models with a `teamId` and/or `orgId` column. Derived from schema.prisma. */
export const TENANT_SCOPED_MODELS = new Set([
  'Agent',
  'AutonomyPolicy',
  'ConfigPermission',
  'ConfigSetting',
  'Connection',
  'EvalDataset',
  'EvalRubric',
  'HumanErrorBaseline',
  'MemoryItem',
  'OrgMonthlyUsage',
  'OrganizationMembership',
  'ProviderCredential',
  'Skill',
  'SlackChannel',
  'SlackWorkspace',
  'Team',
  'TeamMembership',
  'WorkflowShellAudit',
  'WorkflowTemplate',
]);

/** Operations that can touch many tenants' rows in one call. */
export const GUARDED_OPERATIONS = new Set([
  'aggregate',
  'count',
  'deleteMany',
  'findMany',
  'groupBy',
  'updateMany',
]);

/**
 * Keys that scope a query to a tenant, directly or through a relation.
 *
 * `channelId` counts because a `SlackChannel` belongs to exactly one team, so a
 * non-null channel id names exactly one tenant — the two tenant-scoped models
 * that carry the column (`MemoryItem`, `Agent`) both inherit their tenant from
 * the channel.
 */
const TENANT_KEYS = new Set([
  'channelId',
  'orgId',
  'organization',
  'organizationId',
  'team',
  'teamId',
  'memberships',
]);

/**
 * Keys whose `null` still scopes, because null means "belongs to no tenant".
 *
 * `teamId: null` selects the GLOBAL rows — bundle export relies on it — and
 * those are nobody's private data. `channelId: null` is the opposite: a
 * `MemoryItem` with no channel is still owned by a team, so that predicate
 * selects every team's non-channel lessons and must not count.
 */
const NULL_SCOPES_TENANT = new Set(['orgId', 'organizationId', 'teamId']);

/** Relation/scalar operators that select everything *except* a tenant. */
const NEGATING_OPERATORS = new Set(['none', 'not', 'isNot']);

/** Does `value`, sitting under tenant key `key`, actually narrow to a tenant? */
function narrowsToTenant(key: string, value: unknown): boolean {
  if (value === null || value === undefined) {
    return NULL_SCOPES_TENANT.has(key);
  }
  if (typeof value === 'object') {
    // `{ teamId: { not: x } }` and `{ memberships: { none: … } }` match every
    // tenant but one, which is the opposite of scoping.
    return !Object.keys(value as Record<string, unknown>).some((k) => NEGATING_OPERATORS.has(k));
  }
  return true;
}

const unscoped = new AsyncLocalStorage<{ reason: string; models: ReadonlySet<string> }>();

/**
 * Marks a genuinely cross-tenant query as intentional, for named models only.
 *
 * Plenty are: admin listings, startup sync, seeds, the worker's global config
 * resolvers. The point is not to forbid them but to make each one a written
 * decision with a reason attached, so the unmarked ones stand out.
 *
 * **`models` is what keeps the exemption honest.** This is an
 * `AsyncLocalStorage` region, so everything awaited inside inherits it —
 * including a query added to the block later, or one issued by a helper it
 * calls. Several call sites legitimately wrap a `Promise.all` of two or three
 * queries, so a one-query-per-region rule would not fit. Naming the models
 * bounds it instead: a query on anything else still fails, and the exemption
 * states what it was granted for rather than "whatever happens in here". A
 * second query on an already-named model does still inherit it — a deliberately
 * narrower hole than the unbounded region had.
 *
 * **Promises are awaited inside the region.** `AsyncLocalStorage.run` only
 * covers the synchronous call to `fn`; a Prisma query returns a thenable that
 * executes when it is later `await`ed. Every call site writes
 * `await runUnscoped(..., () => prisma.x.findMany(...))` — the `await` is
 * outside `run`, so without awaiting here the guard's `isUnscoped` check runs
 * in the root context and throws on every admin listing. When `fn` returns a
 * thenable we await it inside `run` and return its resolved value, preserving
 * the `() => T` signature for synchronous callers.
 */
export function runUnscoped<T>(reason: string, models: readonly string[], fn: () => T): T {
  const ctx = { models: new Set(models), reason };
  const result = unscoped.run(ctx, fn);
  // Prisma queries return a thenable that only executes when awaited. ALS.run
  // only covers the synchronous call to `fn`, so an outer `await` (the shape
  // every call site uses) would resume in the root context and the guard's
  // isUnscoped check throws. Wrap the await inside an async fn run in the same
  // ALS context so the query's $allOperations hook sees the exemption.
  if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
    return unscoped.run(ctx, async () => result as unknown as Promise<unknown>) as unknown as T;
  }
  return result;
}

/** Is `model` covered by an active exemption? */
export function isUnscoped(model: string): boolean {
  return unscoped.getStore()?.models.has(model) ?? false;
}

/** Does this `where` clause constrain the query to a tenant? */
export function hasTenantPredicate(where: unknown): boolean {
  if (!where || typeof where !== 'object') {
    return false;
  }
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    // `NOT: { teamId: x }` matches every tenant except x. Descending into it
    // would read the tenant key inside as scoping and invert the guard.
    if (key === 'NOT') {
      continue;
    }
    if (TENANT_KEYS.has(key)) {
      if (narrowsToTenant(key, value)) {
        return true;
      }
      continue;
    }
    // Recurse through *any* nested object, not just AND/OR. Tenancy is
    // routinely reached through a relation two or three levels down —
    // `{ repository: { team: { memberships: { some: … } } } }` is how the
    // lessons routes scope, and treating that as unscoped would be a false
    // positive on correct code, which is the fastest way to get a guard
    // switched off.
    //
    // OR counts as scoping: `OR: [{ teamId: null }, { team: … }]` is the
    // standard "global rows plus mine" shape, and its unfiltered-looking branch
    // is deliberate.
    if (value && typeof value === 'object') {
      const branches = Array.isArray(value) ? value : [value];
      if (branches.some((b) => hasTenantPredicate(b))) {
        return true;
      }
    }
  }
  return false;
}

export class UnscopedTenantQueryError extends Error {
  constructor(model: string, operation: string) {
    super(
      `${model}.${operation}() ran with no tenant predicate. ${model} carries a teamId/orgId, ` +
        'so an unfiltered query crosses tenants. Add the filter, or wrap the call in ' +
        `runUnscoped('why this is global', ['${model}'], () => …) if it is meant to be.`
    );
    this.name = 'UnscopedTenantQueryError';
  }
}

export interface TenantGuardOptions {
  /**
   * `'throw'` fails the query; `'warn'` logs and lets it through.
   *
   * Defaults to `'throw'` in all environments. Every gateway call site has
   * been triaged — each cross-tenant query now declares itself through
   * `runUnscoped` or `asPlatformAdmin` — so a new violation is a new bug and
   * should stop a test rather than be logged and forgotten.
   *
   * Set `TENANT_GUARD_WARN=1` to warn instead of throw while triaging false
   * positives, but do not leave that enabled in production.
   */
  mode?: 'throw' | 'warn';
  onViolation?: (err: UnscopedTenantQueryError) => void;
}

/** The `$extends` argument. Kept separate from the client so it is unit-testable. */
export function tenantGuardExtension(opts?: TenantGuardOptions) {
  const mode = opts?.mode ?? (process.env.TENANT_GUARD_WARN === '1' ? 'warn' : 'throw');
  return {
    name: 'tenantGuard',
    query: {
      $allModels: {
        async $allOperations({
          args,
          model,
          operation,
          query,
        }: {
          args: unknown;
          model: string;
          operation: string;
          query: (a: unknown) => Promise<unknown>;
        }) {
          if (
            TENANT_SCOPED_MODELS.has(model) &&
            GUARDED_OPERATIONS.has(operation) &&
            !isUnscoped(model) &&
            !hasTenantPredicate((args as { where?: unknown } | undefined)?.where)
          ) {
            const err = new UnscopedTenantQueryError(model, operation);
            opts?.onViolation?.(err);
            if (mode === 'throw') {
              throw err;
            }
            console.warn(`[tenantGuard] ${err.message}`);
          }
          return query(args);
        },
      },
    },
  };
}
