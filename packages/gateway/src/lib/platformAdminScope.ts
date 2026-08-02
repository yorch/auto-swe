import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

/**
 * Runs `fn` unscoped **only** when the caller is a platform admin.
 *
 * Most gateway listings are shaped `user.role === 'ADMIN' ? {} : tenantFilter`.
 * The admin branch is a deliberate cross-tenant read, but written that way it
 * is indistinguishable from a forgotten filter — which is exactly the bug
 * `tenantGuard` exists to catch.
 *
 * Wrapping the whole call site in `runUnscoped` would work but would also
 * disable the guard for non-admins, hiding a genuinely missing filter on the
 * path that matters. This keeps the guard live for everyone except the role
 * that is supposed to see everything.
 */
export function asPlatformAdmin<T>(user: { role: string }, reason: string, fn: () => T): T {
  return user.role === 'ADMIN' ? runUnscoped(reason, fn) : fn();
}
