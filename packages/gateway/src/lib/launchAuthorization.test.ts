import { describe, expect, it, vi } from 'vitest';
import { authorizeLaunch, type LaunchRepo } from './launchAuthorization.js';

const USER = { role: 'ENGINEER' as const, sub: 'user-1' };
const ADMIN = { role: 'ADMIN' as const, sub: 'admin-1' };

function repo(over: {
  id?: string;
  member?: boolean;
  orgId?: string;
  cap?: number | null;
  retired?: boolean;
}): LaunchRepo {
  return {
    githubApiUrl: null,
    id: over.id ?? 'repo-1',
    installation: over.retired ? { installationId: 'inst-1', isActive: false } : null,
    organizationName: 'acme',
    repoName: over.id ?? 'repo-1',
    team: {
      memberships: over.member === false ? [] : [{ userId: USER.sub }],
      organization: { monthlyBudgetUsdCents: over.cap ?? null },
      orgId: over.orgId ?? 'org-1',
    },
    type: 'git_repo',
  };
}

function prisma(opts: { orgMembers?: Record<string, boolean>; spentUsd?: Record<string, number> }) {
  return {
    organizationMembership: {
      findUnique: vi.fn(async ({ where }: { where: { userId_orgId: { orgId: string } } }) =>
        opts.orgMembers?.[where.userId_orgId.orgId] === false ? null : { role: 'ORG_MEMBER' }
      ),
    },
    orgMonthlyUsage: {
      findUnique: vi.fn(async ({ where }: { where: { orgId_yearMonth: { orgId: string } } }) => ({
        costUsdAccrued: opts.spentUsd?.[where.orgId_yearMonth.orgId] ?? 0,
      })),
    },
  };
}

const GATE_OFF = { mode: 'off' as const, staleAfterHours: 0 };

describe('authorizeLaunch', () => {
  it('allows a team member of a member org under its cap', async () => {
    const decision = await authorizeLaunch(prisma({}) as never, USER, {
      gate: GATE_OFF,
      repos: [repo({ cap: 1000 })],
    });
    expect(decision).toEqual({ ok: true });
  });

  it('refuses a non-member with the single-repository body', async () => {
    const decision = await authorizeLaunch(prisma({}) as never, USER, {
      gate: GATE_OFF,
      repos: [repo({ member: false })],
    });
    expect(decision).toMatchObject({
      ok: false,
      refusal: {
        body: { error: { code: 'FORBIDDEN', reason: 'not-a-team-member' } },
        kind: 'repo-access',
        status: 403,
      },
    });
  });

  it('names every refused repository in the multi-repository body', async () => {
    const decision = await authorizeLaunch(prisma({}) as never, USER, {
      gate: GATE_OFF,
      refusalShape: 'multi',
      repos: [
        repo({ id: 'a', member: false }),
        repo({ id: 'b' }),
        repo({ id: 'c', member: false }),
      ],
    });
    if (decision.ok) {
      throw new Error('expected a refusal');
    }
    expect(decision.refusal.body.error.reasons).toEqual([
      { reason: 'not-a-team-member', repo: 'acme/a' },
      { reason: 'not-a-team-member', repo: 'acme/c' },
    ]);
  });

  it('refuses a team member who is not a member of the repository org', async () => {
    const decision = await authorizeLaunch(
      prisma({ orgMembers: { 'org-1': false } }) as never,
      USER,
      {
        gate: GATE_OFF,
        repos: [repo({})],
      }
    );
    expect(decision).toMatchObject({ ok: false, refusal: { kind: 'org-access', status: 403 } });
  });

  it('checks every org a multi-org launch spends against', async () => {
    const db = prisma({ orgMembers: { 'org-2': false } });
    const decision = await authorizeLaunch(db as never, USER, {
      gate: GATE_OFF,
      repos: [repo({ id: 'a', orgId: 'org-1' }), repo({ id: 'b', orgId: 'org-2' })],
    });
    expect(decision).toMatchObject({ ok: false, refusal: { kind: 'org-access' } });
  });

  it('refuses with 402 once spend reaches the cap', async () => {
    const decision = await authorizeLaunch(prisma({ spentUsd: { 'org-1': 10 } }) as never, USER, {
      gate: GATE_OFF,
      repos: [repo({ cap: 1000 })],
    });
    expect(decision).toMatchObject({
      ok: false,
      refusal: {
        body: { error: { code: 'ORG_BUDGET_EXCEEDED' } },
        kind: 'org-budget',
        status: 402,
      },
    });
  });

  it('checks an org passed without a repository (a template run with no connection)', async () => {
    const decision = await authorizeLaunch(prisma({ spentUsd: { 'org-t': 5 } }) as never, USER, {
      gate: GATE_OFF,
      orgs: [{ id: 'org-t', monthlyBudgetUsdCents: 500 }],
      repos: [],
    });
    expect(decision).toMatchObject({ ok: false, refusal: { kind: 'org-budget' } });
  });

  it('lets an ADMIN past membership but not past the cap or a retired installation', async () => {
    const db = prisma({ orgMembers: { 'org-1': false }, spentUsd: { 'org-1': 0 } });
    expect(
      await authorizeLaunch(db as never, ADMIN, {
        gate: GATE_OFF,
        repos: [repo({ member: false })],
      })
    ).toEqual({ ok: true });
    expect(db.organizationMembership.findUnique).not.toHaveBeenCalled();

    expect(
      await authorizeLaunch(prisma({ spentUsd: { 'org-1': 10 } }) as never, ADMIN, {
        gate: GATE_OFF,
        repos: [repo({ cap: 1000 })],
      })
    ).toMatchObject({ ok: false, refusal: { kind: 'org-budget' } });

    expect(
      await authorizeLaunch(prisma({}) as never, ADMIN, {
        gate: GATE_OFF,
        repos: [repo({ retired: true })],
      })
    ).toMatchObject({
      ok: false,
      refusal: { body: { error: { code: 'INSTALLATION_RETIRED' } }, kind: 'repo-access' },
    });
  });

  it('decides repository access before touching org membership', async () => {
    const db = prisma({});
    await authorizeLaunch(db as never, USER, { gate: GATE_OFF, repos: [repo({ member: false })] });
    expect(db.organizationMembership.findUnique).not.toHaveBeenCalled();
    expect(db.orgMonthlyUsage.findUnique).not.toHaveBeenCalled();
  });
});
