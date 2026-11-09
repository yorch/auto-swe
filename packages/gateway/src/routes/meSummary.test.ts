import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveSetting: vi.fn(), resolveSettings: vi.fn() }));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: mocks.resolveSetting,
  resolveSettings: mocks.resolveSettings,
  SETTING_DEFINITIONS: { 'workflow.approvalDueSoonHours': { defaultValue: 24 } },
}));

// Org spend comes from the mock's `orgMonthlyUsage` row (see test/billingMock.ts).
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

import { humanStepMineScope } from '../lib/humanStepFilters.js';
import { memberRunScope } from '../lib/runTeamScope.js';
import { meRoutes } from './me.js';

const ME = 'user-1';
const HOUR = 60 * 60 * 1000;

const teamA = { id: 'team-a', name: 'Alpha', slug: 'alpha' };
const teamB = { id: 'team-b', name: 'Beta', slug: 'beta' };
const repo = (team: typeof teamA, shares: string[] = []) => ({
  name: 'r',
  organizationName: 'acme',
  repoName: `repo-${team.slug}`,
  shares: shares.map((teamId) => ({ teamId })),
  team,
});

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    connection: repo(teamA),
    template: { team: null },
    workflowId: 'wf-1',
    workRequest: { activeWorkflows: [], connection: null, id: 'wr-1', isCrossRepo: false },
    ...overrides,
  };
}

/** Month-to-date spend in USD by org id, read through the billing mock. */
const orgSpend: Record<string, number> = {};

async function buildApp(role: 'ENGINEER' | 'ADMIN' = 'ENGINEER') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    organization: { findMany: vi.fn() },
    orgMonthlyUsage: {
      findUnique: vi.fn(async (args: { where: { orgId_yearMonth: { orgId: string } } }) => {
        const cost = orgSpend[args.where.orgId_yearMonth.orgId];
        return cost === undefined ? null : { costUsdAccrued: cost };
      }),
    },
    teamMembership: { findMany: vi.fn() },
    workflowHumanStep: { findMany: vi.fn() },
    workflowRun: { findMany: vi.fn() },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: ME }),
  } as unknown as never);
  await app.register(meRoutes, { prefix: '/api/v1/me' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake-jwt' };
const membership = (team: typeof teamA, role = 'ENGINEER') => ({
  role,
  team: { ...team, organization: { name: 'Acme' }, orgId: 'org-1' },
});

describe('GET /api/v1/me/summary', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    mocks.resolveSetting.mockReset().mockResolvedValue(24);
    ctx.prisma.organization.findMany.mockReset().mockResolvedValue([]);
    for (const key of Object.keys(orgSpend)) {
      delete orgSpend[key];
    }
    ctx.prisma.teamMembership.findMany.mockReset().mockResolvedValue([membership(teamA)]);
    ctx.prisma.workflowHumanStep.findMany.mockReset().mockResolvedValue([]);
    ctx.prisma.workflowRun.findMany.mockReset().mockResolvedValue([]);
  });

  const get = async () => {
    const res = await ctx.app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/me/summary' });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      needsYou: { items: { key: string; kind: string; teamSlug: string | null }[]; total: number };
      teams: { slug: string; myRole: string; needsYou: number; running: number; queued: number }[];
    };
  };

  const step = (id: string, hoursToDeadline: number | null, requestedAgoHours: number) => ({
    id,
    requestedAt: new Date(Date.now() - requestedAgoHours * HOUR),
    run: { ...runRow(), id: 'run-1' },
    runId: 'run-1',
    timeoutAt: hoursToDeadline === null ? null : new Date(Date.now() + hoursToDeadline * HOUR),
    title: `step ${id}`,
  });

  it('returns an empty desk for a caller with no teams, without reading work', async () => {
    ctx.prisma.teamMembership.findMany.mockResolvedValue([]);
    const body = await get();
    expect(body).toEqual({ needsYou: { items: [], total: 0 }, teams: [] });
    expect(ctx.prisma.workflowHumanStep.findMany).not.toHaveBeenCalled();
  });

  it('lists only active teams the caller belongs to, with role and org', async () => {
    ctx.prisma.teamMembership.findMany.mockResolvedValue([
      membership(teamA, 'LEAD'),
      membership(teamB),
    ]);
    const body = await get();
    expect(body.teams.map((t) => [t.slug, t.myRole])).toEqual([
      ['alpha', 'LEAD'],
      ['beta', 'ENGINEER'],
    ]);
    expect(ctx.prisma.teamMembership.findMany.mock.calls[0][0].where).toEqual({
      team: { isActive: true },
      userId: ME,
    });
  });

  describe('budget', () => {
    const capped = (id: string, cap: number | null) => ({
      budgetAlertThresholdPercent: 80,
      id,
      monthlyBudgetUsdCents: cap,
    });
    const inOrg = (team: typeof teamA, orgId: string) => {
      const m = membership(team);
      return { ...m, team: { ...m.team, orgId } };
    };

    it('is null on a team whose org has no cap', async () => {
      ctx.prisma.organization.findMany.mockResolvedValue([capped('org-1', null)]);
      const { teams } = (await get()) as unknown as { teams: { budget: unknown }[] };
      expect(teams[0].budget).toBeNull();
    });

    it('is the org status as a percentage and a state, with no dollar field, for an ENGINEER', async () => {
      ctx.prisma.organization.findMany.mockResolvedValue([capped('org-1', 100_000)]);
      orgSpend['org-1'] = 100;
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/me/summary',
      });
      const body = res.json() as { teams: { budget: Record<string, unknown> }[] };
      expect(body.teams[0].budget).toMatchObject({ percentUsed: 10, scope: 'org', state: 'ok' });
      expect(res.body).not.toMatch(/usd|cents/i);
    });

    it('reads every org in one query and gives each team only its own org', async () => {
      ctx.prisma.teamMembership.findMany.mockResolvedValue([
        inOrg(teamA, 'org-1'),
        inOrg(teamB, 'org-2'),
      ]);
      ctx.prisma.organization.findMany.mockResolvedValue([
        capped('org-1', 100_000),
        capped('org-2', 1000),
      ]);
      orgSpend['org-1'] = 100;
      orgSpend['org-2'] = 20;
      const { teams } = (await get()) as unknown as {
        teams: { slug: string; budget: { percentUsed: number; state: string } }[];
      };
      expect(ctx.prisma.organization.findMany).toHaveBeenCalledTimes(1);
      expect(ctx.prisma.organization.findMany.mock.calls[0][0].where).toEqual({
        id: { in: ['org-1', 'org-2'] },
      });
      expect(teams.map((t) => [t.slug, t.budget.percentUsed, t.budget.state])).toEqual([
        ['alpha', 10, 'ok'],
        ['beta', 200, 'over'],
      ]);
    });

    it('never asks for an org the caller has no team in', async () => {
      // The caller belongs to org-A only; the read names org-A and nothing else.
      ctx.prisma.teamMembership.findMany.mockResolvedValue([inOrg(teamA, 'org-A')]);
      ctx.prisma.organization.findMany.mockResolvedValue([capped('org-A', 1000)]);
      orgSpend['org-A'] = 1;
      orgSpend['org-B'] = 999;
      const { teams } = (await get()) as unknown as {
        teams: { budget: { percentUsed: number } }[];
      };
      expect(ctx.prisma.organization.findMany.mock.calls[0][0].where).toEqual({
        id: { in: ['org-A'] },
      });
      expect(teams[0].budget.percentUsed).toBe(10);
    });
  });

  it('orders due-soon approvals first by deadline, then the rest newest first', async () => {
    ctx.prisma.workflowHumanStep.findMany.mockResolvedValue([
      step('plain-old', null, 10),
      step('far', 100, 3),
      step('soon-late', 20, 5),
      step('soon-early', 2, 9),
      step('plain-new', null, 1),
    ]);
    const body = await get();
    expect(body.needsYou.items.map((i) => [i.key, i.kind])).toEqual([
      ['soon-early', 'approval_due_soon'],
      ['soon-late', 'approval_due_soon'],
      ['plain-new', 'approval'],
      ['far', 'approval'],
      ['plain-old', 'approval'],
    ]);
    expect(body.needsYou.total).toBe(5);
    expect(body.teams[0]).toMatchObject({ needsYou: 5 });
  });

  it('reads the due-soon window from the setting', async () => {
    mocks.resolveSetting.mockResolvedValue(200);
    ctx.prisma.workflowHumanStep.findMany.mockResolvedValue([step('far', 100, 1)]);
    const body = await get();
    expect(body.needsYou.items[0]?.kind).toBe('approval_due_soon');
    expect(mocks.resolveSetting).toHaveBeenCalledWith('workflow.approvalDueSoonHours', {});
  });

  it('caps the list at 25 but reports the pre-cap total', async () => {
    ctx.prisma.workflowHumanStep.findMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => step(`s${i}`, null, i + 1))
    );
    const body = await get();
    expect(body.needsYou.items).toHaveLength(25);
    expect(body.needsYou.total).toBe(30);
    expect(body.needsYou.items[0]?.key).toBe('s0');
  });

  const attempt = (id: string, status: string, launchedById: string | null, extra = {}) => ({
    ...runRow({ workflowId: `wf-${id}` }),
    _count: { humanSteps: 0 },
    endedAt: new Date(),
    id,
    launchedById,
    startedAt: new Date(),
    status,
    workRequest: {
      activeWorkflows: [],
      connection: null,
      description: 'desc',
      externalTicketId: 'T-1',
      id: `wr-${id}`,
      isCrossRepo: false,
      requestedById: 'someone',
      title: null,
      ...extra,
    },
    workRequestId: `wr-${id}`,
  });

  it('includes failed latest attempts only when the caller launched them', async () => {
    ctx.prisma.workflowRun.findMany.mockResolvedValueOnce([
      attempt('mine', 'FAILED', ME),
      attempt('theirs', 'FAILED', 'other'),
      attempt('ok', 'SUCCESS', ME),
    ]);
    const body = await get();
    expect(body.needsYou.items.map((i) => [i.key, i.kind])).toEqual([['mine', 'failed_run']]);
  });

  it("lists a failed attempt the caller launched even when another launcher's sorts first", async () => {
    const crossRepo = { isCrossRepo: true };
    ctx.prisma.workflowRun.findMany.mockResolvedValueOnce([
      {
        ...attempt('erin-fail', 'FAILED', 'erin', crossRepo),
        connection: repo(teamB),
        workRequestId: 'wr-x',
      },
      {
        ...attempt('mine-fail', 'FAILED', ME, crossRepo),
        connection: repo(teamA),
        workRequestId: 'wr-x',
      },
    ]);
    ctx.prisma.teamMembership.findMany.mockResolvedValue([membership(teamA), membership(teamB)]);
    const body = await get();
    expect(body.needsYou.items.map((i) => [i.key, i.kind, i.teamSlug])).toEqual([
      ['mine-fail', 'failed_run', 'alpha'],
    ]);
    expect(body.teams.map((t) => [t.slug, t.needsYou])).toEqual([
      ['alpha', 1],
      ['beta', 0],
    ]);
  });

  it('emits one merge item per awaiting execution the caller requested, each in its own team', async () => {
    const awaiting = (id: string, team: typeof teamA) => ({
      ...attempt(id, 'RUNNING', 'other', {
        activeWorkflows: [
          {
            currentStatus: 'AWAITING_HUMAN_MERGE',
            repository: repo(team),
            temporalWorkflowId: `wf-${id}`,
            updatedAt: new Date(),
          },
        ],
        isCrossRepo: true,
        requestedById: ME,
      }),
      connection: repo(team),
      workRequestId: 'wr-x',
    });
    ctx.prisma.teamMembership.findMany.mockResolvedValue([membership(teamA), membership(teamB)]);
    ctx.prisma.workflowRun.findMany.mockResolvedValueOnce([
      awaiting('m-a', teamA),
      awaiting('m-b', teamB),
    ]);
    const body = await get();
    expect(body.needsYou.items.map((i) => [i.key, i.teamSlug]).sort()).toEqual([
      ['m-a', 'alpha'],
      ['m-b', 'beta'],
    ]);
  });

  it('does not name a repository the run does not act on for a multi-repository request', async () => {
    ctx.prisma.workflowRun.findMany.mockResolvedValueOnce([
      {
        ...attempt('x', 'FAILED', ME, {
          activeWorkflows: [
            {
              currentStatus: 'IMPLEMENTING',
              repository: { ...repo(teamB), repoName: 'secret-repo' },
              temporalWorkflowId: 'wf-other',
              updatedAt: new Date(),
            },
          ],
          isCrossRepo: true,
        }),
        connection: null,
        template: { team: teamA },
      },
    ]);
    const body = await get();
    expect(JSON.stringify(body)).not.toContain('secret-repo');
  });

  it('includes a request the caller made that awaits a human merge, once', async () => {
    ctx.prisma.workflowRun.findMany.mockResolvedValueOnce([
      attempt('pr', 'RUNNING', 'other', {
        activeWorkflows: [
          {
            currentStatus: 'AWAITING_HUMAN_MERGE',
            repository: repo(teamA),
            temporalWorkflowId: 'wf-pr',
            updatedAt: new Date(),
          },
        ],
        requestedById: ME,
      }),
    ]);
    const body = await get();
    expect(body.needsYou.items.map((i) => [i.key, i.kind, i.teamSlug])).toEqual([
      ['pr', 'pr_merge', 'alpha'],
    ]);
  });

  // A latest attempt as the running query returns it.
  const running = (id: string, extra: Record<string, unknown> = {}) => {
    const row = runRow({ workflowId: `wf-${id}`, ...extra });
    return {
      ...row,
      id,
      status: 'RUNNING',
      workRequest: { ...row.workRequest, id: `wr-${id}` },
      workRequestId: `wr-${id}`,
    };
  };

  it('counts a multi-repository request once per team, and its queued stage by the running run', async () => {
    const execution = (id: string, status: string, stage: string) => {
      const row = running(id, {
        workRequest: {
          activeWorkflows: [
            { currentStatus: stage, repository: null, temporalWorkflowId: `wf-${id}` },
          ],
          connection: null,
          id: 'wr-x',
          isCrossRepo: true,
        },
      });
      return { ...row, status, workRequestId: 'wr-x' };
    };
    ctx.prisma.workflowRun.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        execution('done', 'SUCCESS', 'COMPLETED'),
        execution('starting', 'RUNNING', 'STARTING'),
        execution('busy', 'RUNNING', 'IMPLEMENTING'),
      ]);
    const body = await get();
    // One request: one list row under state=active, in the stage of its first running execution.
    expect(body.teams[0]).toMatchObject({ queued: 1, running: 0 });
  });

  it('does not count a request whose newest attempt is finished', async () => {
    ctx.prisma.workflowRun.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...running('done'), status: 'SUCCESS' }]);
    const body = await get();
    expect(body.teams[0]).toMatchObject({ queued: 0, running: 0 });
  });

  it('counts running and queued per member team, shared repositories included', async () => {
    ctx.prisma.teamMembership.findMany.mockResolvedValue([membership(teamA), membership(teamB)]);
    const queued = runRow({
      connection: repo(teamA, [teamB.id]),
      workRequest: {
        activeWorkflows: [
          { currentStatus: 'STARTING', repository: null, temporalWorkflowId: 'wf-1' },
        ],
        connection: null,
        id: 'wr',
        isCrossRepo: false,
      },
    });
    ctx.prisma.workflowRun.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        running('r1', { connection: repo(teamA, [teamB.id]) }),
        running('r2', queued),
      ]);
    const body = await get();
    const bySlug = Object.fromEntries(body.teams.map((t) => [t.slug, t]));
    expect(bySlug.alpha).toMatchObject({ queued: 1, running: 1 });
    expect(bySlug.beta).toMatchObject({ queued: 1, running: 1 });
  });

  it('does not count teams the caller is not a member of', async () => {
    ctx.prisma.workflowRun.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([running('r1', { connection: repo(teamB) })]);
    const body = await get();
    expect(body.teams).toHaveLength(1);
    expect(body.teams[0]).toMatchObject({ running: 0 });
  });

  it('member-scopes every work query, for a platform ADMIN too', async () => {
    const admin = await buildApp('ADMIN');
    admin.prisma.teamMembership.findMany.mockResolvedValue([membership(teamA)]);
    admin.prisma.organization.findMany.mockResolvedValue([]);
    admin.prisma.workflowHumanStep.findMany.mockResolvedValue([]);
    admin.prisma.workflowRun.findMany.mockResolvedValue([]);
    const res = await admin.app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/me/summary',
    });
    expect(res.statusCode).toBe(200);
    const adminUser = { role: 'ADMIN', sub: ME };
    const stepWhere = admin.prisma.workflowHumanStep.findMany.mock.calls[0][0].where;
    expect(stepWhere.AND).toContainEqual(humanStepMineScope(adminUser as never));
    for (const call of admin.prisma.workflowRun.findMany.mock.calls) {
      expect(call[0].where.AND).toContainEqual(memberRunScope(adminUser as never));
    }
    await admin.app.close();
  });

  it('ANDs the member scopes onto every work query for a non-admin', async () => {
    await get();
    const user = { role: 'ENGINEER', sub: ME };
    expect(ctx.prisma.workflowHumanStep.findMany.mock.calls[0][0].where.AND).toContainEqual(
      humanStepMineScope(user as never)
    );
    expect(ctx.prisma.workflowRun.findMany.mock.calls).toHaveLength(2);
    for (const call of ctx.prisma.workflowRun.findMany.mock.calls) {
      expect(call[0].where.AND).toContainEqual(memberRunScope(user as never));
    }
  });

  it('scopes work to active teams, matching the cards', () => {
    const scope = JSON.stringify(memberRunScope({ sub: ME }));
    const memberTerms = scope.match(/"memberships"/g)?.length ?? 0;
    expect(memberTerms).toBeGreaterThan(0);
    expect(scope.match(/"isActive":true/g)?.length).toBe(memberTerms);
  });

  it('bounds the attempts query by age but always reads running attempts', async () => {
    await get();
    const where = ctx.prisma.workflowRun.findMany.mock.calls[0][0].where;
    const windowTerm = where.AND.find((t: Record<string, unknown>) =>
      JSON.stringify(t).includes('startedAt')
    );
    expect(JSON.stringify(windowTerm)).toContain('"status":"RUNNING"');
    expect(JSON.stringify(windowTerm)).toContain('startedAt');
  });

  it('falls back to the default due-soon window when the setting cannot be read', async () => {
    mocks.resolveSetting.mockRejectedValue(new Error('db down'));
    ctx.prisma.workflowHumanStep.findMany.mockResolvedValue([
      step('soon', 20, 1),
      step('far', 30, 1),
    ]);
    const body = await get();
    expect(body.needsYou.items.map((i) => [i.key, i.kind])).toEqual([
      ['soon', 'approval_due_soon'],
      ['far', 'approval'],
    ]);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/summary' });
    expect(res.statusCode).toBe(401);
  });
});
