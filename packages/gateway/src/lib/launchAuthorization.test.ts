import { describe, expect, it, vi } from 'vitest';
import { authorizeLaunch, authorizeServiceLaunch, type LaunchRepo } from './launchAuthorization.js';

// Org spend comes from the mock's `orgMonthlyUsage` row (see test/billingMock.ts).
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

const USER = { role: 'ENGINEER' as const, sub: 'user-1' };
const ADMIN = { role: 'ADMIN' as const, sub: 'admin-1' };

function repo(over: {
  id?: string;
  member?: boolean;
  orgId?: string;
  cap?: number | null;
  teamCap?: number | null;
  teamId?: string;
  retired?: boolean;
  /** A share the acting user belongs to (they are then not an owning-team member). */
  shareCanLaunch?: boolean;
}): LaunchRepo {
  return {
    githubApiUrl: null,
    githubUrl: null,
    id: over.id ?? 'repo-1',
    installation: over.retired ? { host: '', installationId: 'inst-1', isActive: false } : null,
    organizationName: 'acme',
    repoName: over.id ?? 'repo-1',
    shares:
      over.shareCanLaunch === undefined
        ? []
        : [{ canLaunch: over.shareCanLaunch, team: { memberships: [{ userId: USER.sub }] } }],
    team: {
      id: over.teamId ?? 'team-1',
      memberships: over.member === false ? [] : [{ userId: USER.sub }],
      monthlyBudgetUsdCents: over.teamCap ?? null,
      name: 'Payments',
      organization: { monthlyBudgetUsdCents: over.cap ?? null },
      orgId: over.orgId ?? 'org-1',
    },
    type: 'git_repo',
  };
}

function prisma(opts: {
  orgMembers?: Record<string, boolean>;
  spentUsd?: Record<string, number>;
  teamSpentUsd?: Record<string, number>;
}) {
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
    teamSpendUsd: opts.teamSpentUsd,
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

  describe('team budgets', () => {
    const over = { teamCap: 1000, teamSpentUsd: { 'team-1': 10 } };

    it("refuses with 402 TEAM_BUDGET_EXCEEDED once the OWNING team's spend reaches its cap", async () => {
      const decision = await authorizeLaunch(prisma(over) as never, USER, {
        gate: GATE_OFF,
        repos: [repo({ teamCap: 1000 })],
      });
      expect(decision).toMatchObject({
        ok: false,
        refusal: {
          body: { error: { code: 'TEAM_BUDGET_EXCEEDED' } },
          kind: 'team-budget',
          status: 402,
        },
      });
    });

    it('names the team to its member, and no amount', async () => {
      const decision = await authorizeLaunch(prisma(over) as never, USER, {
        gate: GATE_OFF,
        repos: [repo({ teamCap: 1000 })],
      });
      if (decision.ok) {
        throw new Error('expected a refusal');
      }
      expect(decision.refusal.body.error.message).toContain('Payments');
      expect(decision.refusal.body.error.message).not.toMatch(/\d/);
    });

    it("does not name a team the caller is not a member of (a sharee on the owner's repository)", async () => {
      const decision = await authorizeLaunch(prisma(over) as never, USER, {
        gate: GATE_OFF,
        repos: [repo({ member: false, shareCanLaunch: true, teamCap: 1000 })],
      });
      if (decision.ok) {
        throw new Error('expected a refusal');
      }
      expect(decision.refusal.body.error.code).toBe('TEAM_BUDGET_EXCEEDED');
      expect(decision.refusal.body.error.message).not.toContain('Payments');
      expect(decision.refusal.body.error.message).not.toMatch(/\d/);
    });

    it('lets a launch through under the cap, with no cap, and at one cent under', async () => {
      const db = (usd: number) => prisma({ teamSpentUsd: { 'team-1': usd } }) as never;
      const launch = (usd: number, teamCap: number | null) =>
        authorizeLaunch(db(usd), USER, { gate: GATE_OFF, repos: [repo({ teamCap })] });
      expect(await launch(9.99, 1000)).toEqual({ ok: true });
      expect(await launch(1000, null)).toEqual({ ok: true });
      expect(await launch(10, 1000)).toMatchObject({ ok: false });
    });

    it('refuses every launch under a zero cap, even with nothing spent', async () => {
      const decision = await authorizeLaunch(prisma({}) as never, USER, {
        gate: GATE_OFF,
        repos: [repo({ teamCap: 0 })],
      });
      expect(decision).toMatchObject({ ok: false, refusal: { kind: 'team-budget' } });
    });

    it('applies the org cap first, so a launch over both is told about the organization', async () => {
      const decision = await authorizeLaunch(
        prisma({ spentUsd: { 'org-1': 10 }, ...over }) as never,
        USER,
        { gate: GATE_OFF, repos: [repo({ cap: 1000, teamCap: 1000 })] }
      );
      expect(decision).toMatchObject({ ok: false, refusal: { kind: 'org-budget' } });
    });

    it('holds the team to its cap when the org has none (the tighter cap binds)', async () => {
      const decision = await authorizeLaunch(prisma(over) as never, USER, {
        gate: GATE_OFF,
        repos: [repo({ cap: null, teamCap: 1000 })],
      });
      expect(decision).toMatchObject({ ok: false, refusal: { kind: 'team-budget' } });
    });

    it('does not let a platform ADMIN past a team cap', async () => {
      const decision = await authorizeLaunch(prisma(over) as never, ADMIN, {
        gate: GATE_OFF,
        repos: [repo({ teamCap: 1000 })],
      });
      expect(decision).toMatchObject({ ok: false, refusal: { kind: 'team-budget' } });
    });

    it('checks a team passed without a repository (a template run with no connection)', async () => {
      const decision = await authorizeLaunch(
        prisma({ teamSpentUsd: { 'team-t': 5 } }) as never,
        USER,
        {
          gate: GATE_OFF,
          repos: [],
          teams: [{ id: 'team-t', isMember: true, monthlyBudgetUsdCents: 500, name: 'Docs' }],
        }
      );
      expect(decision).toMatchObject({ ok: false, refusal: { kind: 'team-budget' } });
    });

    it('reads one team once however many of its repositories a launch names', async () => {
      const db = prisma({ teamSpentUsd: { 'team-1': 0 } });
      const decision = await authorizeLaunch(db as never, USER, {
        gate: GATE_OFF,
        repos: [repo({ id: 'a', teamCap: 1000 }), repo({ id: 'b', teamCap: 1000 })],
      });
      expect(decision).toEqual({ ok: true });
    });
  });

  describe('view-only shares', () => {
    it("refuses a sharee's launch through a share with canLaunch false, with its own code", async () => {
      const decision = await authorizeLaunch(prisma({}) as never, USER, {
        gate: GATE_OFF,
        repos: [repo({ member: false, shareCanLaunch: false })],
      });
      expect(decision).toMatchObject({
        ok: false,
        refusal: {
          body: { error: { code: 'REPOSITORY_VIEW_ONLY', reason: 'share-view-only' } },
          kind: 'repo-access',
          status: 403,
        },
      });
    });

    it('lets a sharee launch through a launching share', async () => {
      expect(
        await authorizeLaunch(prisma({}) as never, USER, {
          gate: GATE_OFF,
          repos: [repo({ member: false, shareCanLaunch: true })],
        })
      ).toEqual({ ok: true });
    });

    it('never limits the owning team, whatever the share says', async () => {
      expect(
        await authorizeLaunch(prisma({}) as never, USER, {
          gate: GATE_OFF,
          repos: [repo({ shareCanLaunch: false })],
        })
      ).toEqual({ ok: true });
    });
  });

  describe('service principals', () => {
    const principal = { connectionIds: ['repo-1'], teamId: 'team-s' };
    const svcRepo = (over: { canLaunch?: boolean; cap?: number | null; teamId?: string }) => ({
      id: 'repo-1',
      shares: [{ canLaunch: over.canLaunch ?? true, teamId: 'team-s' }],
      team: {
        id: 'team-1',
        monthlyBudgetUsdCents: over.cap ?? null,
        name: 'Payments',
        organization: { monthlyBudgetUsdCents: null },
        orgId: 'org-1',
      },
      teamId: over.teamId ?? 'team-1',
    });

    it("refuses a principal whose team's share is view-only, and admits a launching share", async () => {
      expect(
        await authorizeServiceLaunch(prisma({}) as never, principal, {
          repos: [svcRepo({ canLaunch: false })],
        })
      ).toMatchObject({ ok: false, refusal: { kind: 'repo-access', status: 403 } });
      expect(
        await authorizeServiceLaunch(prisma({}) as never, principal, { repos: [svcRepo({})] })
      ).toEqual({ ok: true });
    });

    it("holds a principal's launch to the OWNER's cap, without naming the team", async () => {
      const decision = await authorizeServiceLaunch(
        prisma({ teamSpentUsd: { 'team-1': 10 } }) as never,
        principal,
        { repos: [svcRepo({ cap: 1000 })] }
      );
      expect(decision).toMatchObject({ ok: false, refusal: { kind: 'team-budget', status: 402 } });
      if (!decision.ok) {
        expect(decision.refusal.body.error.message).not.toContain('Payments');
      }
    });
  });
});
