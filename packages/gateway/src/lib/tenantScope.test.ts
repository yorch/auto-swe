import { hasTenantPredicate } from '@auto-swe/shared/lib/tenantGuard';
import { describe, expect, it } from 'vitest';
import { memberOrgs, memberTeams, reachableConnections } from './tenantScope.js';

const actor = { sub: '11111111-1111-1111-1111-111111111111' };

/**
 * These are one-line predicates; what is worth pinning is not their shape but
 * the property the rest of the system leans on — that a query carrying one
 * counts as tenant-scoped. `tenantGuard` decides that at run time and
 * `tenantGuard.coverage.test.ts` decides it again statically, so a change here
 * that stopped satisfying `hasTenantPredicate` would turn every call site into
 * an unguarded query at once.
 */
describe('tenant scope predicates', () => {
  it('narrows when nested under the relation it reaches tenancy through', () => {
    expect(hasTenantPredicate({ team: memberTeams(actor) })).toBe(true);
    expect(hasTenantPredicate({ organization: memberOrgs(actor) })).toBe(true);
    expect(hasTenantPredicate({ repository: reachableConnections(actor) })).toBe(true);
  });

  it('narrows through the deeper relation paths the routes actually use', () => {
    // `/runs` reaches a repo's team three relations down; the guard has to see
    // through all of it or every run listing becomes an unscoped query.
    expect(
      hasTenantPredicate({
        workRequest: { activeWorkflows: { some: { repository: reachableConnections(actor) } } },
      })
    ).toBe(true);
    expect(hasTenantPredicate({ fromRepo: reachableConnections(actor) })).toBe(true);
  });

  it('still narrows in the "global rows plus mine" shape', () => {
    // Workflow templates and Slack template pickers use this; the `teamId: null`
    // branch looks unfiltered on its own and is deliberate.
    expect(hasTenantPredicate({ OR: [{ teamId: null }, { team: memberTeams(actor) }] })).toBe(true);
  });

  it('leaves listings unchanged unless the gate is enforcing', () => {
    // Advisory must not filter: reporting what a listing would have hidden
    // means running it twice on every page render. The launch path carries the
    // advisory signal instead.
    for (const mode of ['off', 'advisory'] as const) {
      expect(reachableConnections(actor, { mode, staleAfterHours: 72 })).toEqual({
        team: memberTeams(actor),
      });
    }
    expect(reachableConnections(actor)).toEqual({ team: memberTeams(actor) });
  });

  it('ANDs the permission requirement onto team membership when enforcing', () => {
    // The two conditions must be ANDed, never substituted: a permission row can
    // only ever take access away, so nobody reaches a repository whose team
    // they do not belong to, whatever GitHub says.
    const filter = reachableConnections(actor, { mode: 'enforce', staleAfterHours: 72 });
    expect(filter.team).toEqual(memberTeams(actor));
    expect(filter.repoAccess?.some).toMatchObject({
      permission: { in: ['READ', 'WRITE', 'ADMIN'] },
      userId: actor.sub,
    });
  });

  it('excludes a cached answer older than the staleness bound', () => {
    // Without this a repository whose answers stopped refreshing — a revoked
    // credential, a paused sweep — would be served from a cache nobody updates.
    const before = Date.now();
    const filter = reachableConnections(actor, { mode: 'enforce', staleAfterHours: 24 });
    const cutoff = filter.repoAccess?.some?.checkedAt as { gte: Date };
    expect(cutoff.gte.getTime()).toBeGreaterThanOrEqual(before - 24 * 3600_000 - 5_000);
    expect(cutoff.gte.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 3600_000 + 5_000);
  });

  it('never treats a recorded NONE as viewable', () => {
    const filter = reachableConnections(actor, { mode: 'enforce', staleAfterHours: 72 });
    const levels = (filter.repoAccess?.some?.permission as { in: string[] }).in;
    expect(levels).not.toContain('NONE');
  });

  it('still audits as tenant-scoped when enforcing', () => {
    // The enforced filter adds a key; it must not stop satisfying the guard.
    expect(
      hasTenantPredicate({
        repository: reachableConnections(actor, { mode: 'enforce', staleAfterHours: 72 }),
      })
    ).toBe(true);
  });

  it('binds every predicate to the acting user', () => {
    // A predicate that dropped `userId` would match every membership row and
    // silently scope to "any team that has members", which is all of them.
    for (const predicate of [memberTeams(actor), memberOrgs(actor)]) {
      expect(predicate.memberships).toEqual({ some: { userId: actor.sub } });
    }
    expect(reachableConnections(actor).team).toEqual(memberTeams(actor));
  });
});
