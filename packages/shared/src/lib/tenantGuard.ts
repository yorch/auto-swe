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
  'Connection',
  'EvalDataset',
  'EvalRubric',
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
const GUARDED_OPERATIONS = new Set([
  'aggregate',
  'count',
  'deleteMany',
  'findMany',
  'groupBy',
  'updateMany',
]);

/** Keys that scope a query to a tenant, directly or through a relation. */
const TENANT_KEYS = new Set([
  'orgId',
  'organization',
  'organizationId',
  'team',
  'teamId',
  'memberships',
]);

const unscoped = new AsyncLocalStorage<{ reason: string }>();

/**
 * Marks a genuinely cross-tenant query as intentional.
 *
 * Plenty are: admin listings, startup sync, seeds, the worker's global config
 * resolvers. The point is not to forbid them but to make each one a written
 * decision with a reason attached, so the unmarked ones stand out.
 */
export function runUnscoped<T>(reason: string, fn: () => T): T {
  return unscoped.run({ reason }, fn);
}

export function isUnscoped(): boolean {
  return unscoped.getStore() !== undefined;
}

/** Does this `where` clause constrain the query to a tenant? */
export function hasTenantPredicate(where: unknown): boolean {
  if (!where || typeof where !== 'object') {
    return false;
  }
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (TENANT_KEYS.has(key)) {
      return true;
    }
    // AND/OR/NOT wrap nested clauses; a predicate inside any branch counts.
    // OR is deliberately included: `OR: [{ teamId: null }, { team: … }]` is the
    // standard "global rows plus mine" shape used across the gateway.
    if ((key === 'AND' || key === 'OR' || key === 'NOT') && value) {
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
        "runUnscoped('why this is global', () => …) if it is meant to be."
    );
    this.name = 'UnscopedTenantQueryError';
  }
}

export interface TenantGuardOptions {
  /**
   * `'throw'` fails the query; `'warn'` logs and lets it through.
   *
   * Defaults to `'warn'`, opt in to strict with `TENANT_GUARD_STRICT=1`.
   *
   * Warn is the default because the gateway has ~21 multi-row queries on
   * tenant-scoped models with no visible tenant predicate, and most of them are
   * legitimately global (admin listings, bundle sync, spec validation, a
   * retention sweep). Marking them `runUnscoped` requires knowing each route's
   * authorization model, and a wrong mark is worse than no mark — it
   * permanently silences the guard on a route that did need scoping. So the
   * guard ships observing: turn on strict in a dev or staging run, triage what
   * it reports, mark or fix each one, then flip strict on for good.
   */
  mode?: 'throw' | 'warn';
  onViolation?: (err: UnscopedTenantQueryError) => void;
}

/** The `$extends` argument. Kept separate from the client so it is unit-testable. */
export function tenantGuardExtension(opts?: TenantGuardOptions) {
  const mode = opts?.mode ?? (process.env.TENANT_GUARD_STRICT === '1' ? 'throw' : 'warn');
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
            !isUnscoped() &&
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
