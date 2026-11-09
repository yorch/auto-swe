import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveSetting: vi.fn() }));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: mocks.resolveSetting,
  SETTING_DEFINITIONS: { 'workflow.approvalDueSoonHours': { defaultValue: 24 } },
}));

// Org spend comes from the mock's `orgMonthlyUsage` row (see test/billingMock.ts).
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

import '../test/warmAuthImports.js';
import { teamOverviewRoutes } from './teamOverview.js';

const ME = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM = '33333333-3333-4333-8333-333333333333';
const AUTH = { authorization: 'Bearer fake' };
const URL = `/api/v1/teams/${TEAM}/overview`;

type TeamRole = 'ADMIN' | 'LEAD' | 'ENGINEER' | null;

const teamRef = { id: TEAM, name: 'Alpha', slug: 'alpha' };
const repository = {
  name: 'r',
  organizationName: 'acme',
  repoName: 'api',
  shares: [],
  team: teamRef,
};
const runRow = (overrides: Record<string, unknown> = {}) => ({
  _count: { humanSteps: 0 },
  connection: repository,
  endedAt: new Date('2026-06-02T10:00:00Z'),
  id: 'run-1',
  launchedBy: { name: 'Ada' },
  launchedById: ME,
  startedAt: new Date('2026-06-02T09:00:00Z'),
  status: 'SUCCESS',
  template: { team: null },
  workflowId: 'wf-1',
  workRequest: {
    activeWorkflows: [],
    connection: null,
    description: 'Add endpoint',
    externalTicketId: 'JIRA-1',
    id: 'wr-1',
    isCrossRepo: false,
    title: null,
  },
  workRequestId: 'wr-1',
  ...overrides,
});

interface Fixture {
  activity?: unknown[];
  /** The team's org cap in cents (null: none) and its month-to-date spend in USD. */
  orgCapCents?: number | null;
  /** The viewer's role in the team's org (null: not a member). */
  orgRole?: 'ORG_ADMIN' | 'ORG_MEMBER' | null;
  orgSpendUsd?: number;
  costUsd?: number | null | Error;
  members?: string[];
  openPrs?: number;
  platformRole?: 'ADMIN' | 'LEAD' | 'ENGINEER';
  recent?: unknown[];
  running?: unknown[];
  stale?: number;
  /** Runs with a pending step the caller can answer (the control filter), for the activity feed. */
  controlledRunIds?: string[];
  steps?: unknown[];
  teamRole: TeamRole;
  teamExists?: boolean;
  unowned?: unknown[];
}

async function build(fx: Fixture) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    connection: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'c1', name: 'x', organizationName: 'acme', repoName: 'api', team: teamRef },
        {
          id: 'c2',
          name: 'y',
          organizationName: 'acme',
          repoName: 'lib',
          team: { id: OTHER_TEAM, name: 'Beta' },
        },
      ]),
    },
    organization: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        // Only the team's own org exists in this fixture; any other id is simply absent.
        args.where.id.in.includes('org-1')
          ? [
              {
                budgetAlertThresholdPercent: 80,
                id: 'org-1',
                monthlyBudgetUsdCents: fx.orgCapCents ?? null,
              },
            ]
          : []
      ),
    },
    organizationMembership: {
      findUnique: vi.fn(async () => (fx.orgRole ? { role: fx.orgRole } : null)),
    },
    orgMonthlyUsage: {
      findUnique: vi.fn(async () =>
        fx.orgSpendUsd === undefined ? null : { costUsdAccrued: fx.orgSpendUsd }
      ),
    },
    pullRequest: {
      count: vi.fn().mockResolvedValue(fx.openPrs ?? 0),
      findMany: vi.fn().mockResolvedValue([
        {
          ciStatus: 'PASSED',
          isDraft: false,
          mergedAt: new Date('2026-06-01T04:00:00Z'),
          openedAt: new Date('2026-06-01T00:00:00Z'),
          status: 'MERGED',
        },
        {
          ciStatus: 'FAILED',
          isDraft: false,
          mergedAt: null,
          openedAt: new Date('2026-06-01T00:00:00Z'),
          status: 'CLOSED',
        },
      ]),
    },
    team: {
      findUnique: vi.fn().mockResolvedValue(
        fx.teamExists === false
          ? null
          : {
              id: TEAM,
              memberships: fx.teamRole ? [{ role: fx.teamRole }] : [],
              name: 'Alpha',
              organization: { name: 'Acme' },
              orgId: 'org-1',
              slug: 'alpha',
            }
      ),
    },
    teamMembership: {
      findMany: vi.fn().mockResolvedValue((fx.members ?? [ME]).map((userId) => ({ userId }))),
    },
    workflowHumanStep: {
      count: vi.fn().mockResolvedValue(fx.stale ?? 0),
      findMany: vi.fn(
        async (args: {
          select: Record<string, unknown>;
          where: { AND: Record<string, unknown>[] };
        }) =>
          // The activity feed asks only for `runId`; the desk asks for the whole step with its run.
          'run' in args.select
            ? (fx.steps ?? [])
            : (fx.controlledRunIds ?? []).map((runId) => ({ runId }))
      ),
    },
    workflowRun: {
      aggregate: vi.fn(async (_args: { where: { AND: unknown[] } }) => {
        if (fx.costUsd instanceof Error) {
          throw fx.costUsd;
        }
        return { _sum: { costUsdAccrued: fx.costUsd ?? 0 } };
      }),
      findMany: vi.fn(
        async (args: { select: Record<string, unknown>; take?: number; where: unknown }) => {
          const text = JSON.stringify(args.where);
          if (args.take === 50) {
            return fx.activity ?? [];
          }
          if (text.includes('"workflowRuns":{"some":{"status":"RUNNING"}}')) {
            return fx.running ?? [];
          }
          if (text.includes('"launchedById"')) {
            return [];
          }
          const last = (args.where as { AND: Record<string, unknown>[] }).AND.at(-1) ?? {};
          return 'startedAt' in last ? (fx.recent ?? []) : (fx.unowned ?? []);
        }
      ),
    },
  };
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: fx.platformRole ?? 'ENGINEER',
      sub: ME,
    }),
  } as never);
  await app.register(teamOverviewRoutes, { prefix: '/api/v1/teams' });
  await app.ready();
  return { app, prisma };
}

let open: Awaited<ReturnType<typeof build>> | undefined;
async function get(fx: Fixture, url = URL) {
  open = await build(fx);
  const res = await open.app.inject({ headers: AUTH, url });
  return { prisma: open.prisma, res };
}
afterEach(async () => {
  await open?.app.close();
  open = undefined;
  mocks.resolveSetting.mockReset().mockResolvedValue(24);
});
mocks.resolveSetting.mockResolvedValue(24);

describe('GET /api/v1/teams/:id/overview', () => {
  it('gives a team ENGINEER the base view only: the lead and admin keys are absent', async () => {
    // A platform LEAD whose role in this team is ENGINEER still gets the engineer view.
    const { prisma, res } = await get({ platformRole: 'LEAD', teamRole: 'ENGINEER' });
    expect(res.statusCode, res.body).toBe(200);
    const { data } = res.json();
    expect(data.viewerLevel).toBe('engineer');
    expect(data.team).toEqual({
      id: TEAM,
      myRole: 'ENGINEER',
      name: 'Alpha',
      orgId: 'org-1',
      orgName: 'Acme',
      slug: 'alpha',
    });
    expect('lead' in data).toBe(false);
    expect('admin' in data).toBe(false);
    expect(Object.keys(data).sort()).toEqual(
      [
        'activity',
        'budget',
        'last7d',
        'needsYou',
        'pullRequests',
        'queued',
        'repos',
        'running',
        'team',
        'viewerLevel',
      ].sort()
    );
    // The lead and admin sections are not even queried.
    expect(prisma.workflowHumanStep.count).not.toHaveBeenCalled();
    expect(prisma.pullRequest.count).not.toHaveBeenCalled();
    expect(prisma.workflowRun.aggregate).not.toHaveBeenCalled();
    expect(prisma.teamMembership.findMany).not.toHaveBeenCalled();
  });

  it('gives a team LEAD the lead section and no admin key', async () => {
    const { res } = await get({
      openPrs: 4,
      recent: [],
      stale: 2,
      teamRole: 'LEAD',
      unowned: [
        // Launched by someone no longer on the team, by no one, and by a current member.
        runRow({ id: 'gone', launchedById: 'ex-member', status: 'FAILED', workRequestId: 'w1' }),
        runRow({ id: 'nobody', launchedById: null, status: 'FAILED', workRequestId: 'w2' }),
        runRow({ id: 'mine', launchedById: ME, status: 'FAILED', workRequestId: 'w3' }),
        runRow({ id: 'ok', launchedById: 'ex-member', status: 'SUCCESS', workRequestId: 'w4' }),
      ],
    });
    const { data } = res.json();
    expect(data.viewerLevel).toBe('lead');
    expect(data.lead).toEqual({ openPullRequests: 4, staleApprovals: 2, unownedFailures: 2 });
    expect('admin' in data).toBe(false);
  });

  it('gives a team ADMIN the spend, in cents', async () => {
    const { prisma, res } = await get({ costUsd: 12.345, teamRole: 'ADMIN' });
    const { data } = res.json();
    expect(data.viewerLevel).toBe('admin');
    expect(data.lead).toBeDefined();
    expect(data.admin).toEqual({ monthCostUsdCents: 1235 });
    const where = prisma.workflowRun.aggregate.mock.calls[0][0].where;
    expect(where.AND[1]).toEqual({ attributedTeamId: TEAM });
  });

  it('omits the spend from a team ADMIN who is not an ORG_ADMIN when the org has a cap', async () => {
    const { prisma, res } = await get({
      costUsd: 12.345,
      orgCapCents: 100_000,
      orgRole: 'ORG_MEMBER',
      orgSpendUsd: 450,
      teamRole: 'ADMIN',
    });
    const { data } = res.json();
    expect(data.budget.percentUsed).toBe(45);
    expect(data.admin).toEqual({});
    expect('monthCostUsdCents' in data.admin).toBe(false);
    expect(prisma.workflowRun.aggregate).not.toHaveBeenCalled();
  });

  it('keeps the spend for an ORG_ADMIN who is also the team ADMIN, and for a platform ADMIN', async () => {
    const orgAdmin = await get({
      costUsd: 12.345,
      orgCapCents: 100_000,
      orgRole: 'ORG_ADMIN',
      orgSpendUsd: 450,
      teamRole: 'ADMIN',
    });
    expect(orgAdmin.res.json().data.admin).toEqual({ monthCostUsdCents: 1235 });
    const platform = await get({
      costUsd: 12.345,
      orgCapCents: 100_000,
      orgSpendUsd: 450,
      platformRole: 'ADMIN',
      teamRole: null,
    });
    expect(platform.res.json().data.admin).toEqual({ monthCostUsdCents: 1235 });
  });

  it('reports the spend as null when it cannot be computed', async () => {
    const { res } = await get({ costUsd: new Error('boom'), teamRole: 'ADMIN' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.admin).toEqual({ monthCostUsdCents: null });
  });

  it('gives a platform ADMIN who is not a member the admin view with no team role', async () => {
    const { res } = await get({ platformRole: 'ADMIN', teamRole: null });
    expect(res.statusCode, res.body).toBe(200);
    const { data } = res.json();
    expect(data.viewerLevel).toBe('admin');
    expect(data.team.myRole).toBeNull();
    expect(data.lead).toBeDefined();
    expect(data.admin).toBeDefined();
  });

  it('lets the team role, not the platform role, decide: a platform ADMIN on the team as ENGINEER', async () => {
    const { res } = await get({ platformRole: 'ADMIN', teamRole: 'ENGINEER' });
    expect(res.json().data.viewerLevel).toBe('engineer');
    expect('lead' in res.json().data).toBe(false);
  });

  it('answers the same 404 for a non-member and an unknown team', async () => {
    const nonMember = await get({ teamRole: null });
    const nonMemberBody = nonMember.res.body;
    expect(nonMember.res.statusCode).toBe(404);
    expect(nonMember.res.json().error.code).toBe('TEAM_NOT_FOUND');
    expect(nonMember.prisma.workflowRun.findMany).not.toHaveBeenCalled();
    await open?.app.close();
    const unknown = await get({ teamExists: false, teamRole: null });
    expect(unknown.res.statusCode).toBe(404);
    expect(unknown.res.body).toBe(nonMemberBody);
  });

  it('counts the desk items of this team, running and queued', async () => {
    const step = {
      id: 's1',
      requestedAt: new Date('2026-06-02T00:00:00Z'),
      run: runRow({ id: 'run-s' }),
      runId: 'run-s',
      timeoutAt: null,
      title: 'Approve plan',
    };
    const { prisma, res } = await get({
      running: [
        runRow({
          id: 'r1',
          status: 'RUNNING',
          workflowId: 'wf-a',
          workRequest: {
            ...runRow().workRequest,
            activeWorkflows: [
              { currentStatus: 'STARTING', repository, temporalWorkflowId: 'wf-a' },
            ],
            id: 'wa',
          },
          workRequestId: 'wa',
        }),
        runRow({
          id: 'r2',
          status: 'RUNNING',
          workflowId: 'wf-b',
          workRequest: {
            ...runRow().workRequest,
            activeWorkflows: [
              { currentStatus: 'IMPLEMENTING', repository, temporalWorkflowId: 'wf-b' },
            ],
            id: 'wb',
          },
          workRequestId: 'wb',
        }),
      ],
      steps: [step],
      teamRole: 'ENGINEER',
    });
    const { data } = res.json();
    expect(data.needsYou).toEqual({ total: 1 });
    expect(data.running).toBe(1);
    expect(data.queued).toBe(1);
    // The step query is the actionable list's predicate plus the team term, as its own element.
    const where = prisma.workflowHumanStep.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0].humanApprovals).toEqual({ none: { resolvedBy: ME } });
    expect(where.AND[1]).toHaveProperty('run.OR');
  });

  it('summarises the last 7 days, the pull requests and the repositories', async () => {
    const { res } = await get({
      recent: [
        runRow({ id: 'a', status: 'SUCCESS', workRequestId: 'w1' }),
        runRow({ id: 'b', status: 'FAILED', workRequestId: 'w2' }),
        runRow({ id: 'c', status: 'TIMED_OUT', workRequestId: 'w3' }),
        runRow({ id: 'd', status: 'RUNNING', workRequestId: 'w4' }),
      ],
      teamRole: 'ENGINEER',
    });
    const { data } = res.json();
    expect(data.last7d).toEqual({ failed: 2, started: 4, succeeded: 1 });
    expect(data.pullRequests).toEqual({
      closedUnmerged: 1,
      merged: 1,
      mergeRate: 0.5,
      opened: 2,
      timeToMergeP50Hours: 4,
    });
    expect(data.repos).toEqual([
      { id: 'c1', name: 'acme/api', ownerTeamName: null, relation: 'owned' },
      { id: 'c2', name: 'acme/lib', ownerTeamName: 'Beta', relation: 'shared' },
    ]);
  });

  it('reads only the repositories the caller may reach through the repo gate', async () => {
    const { prisma } = await get({ teamRole: 'ENGINEER' });
    const where = prisma.connection.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(3);
    expect(where.AND[0]).toHaveProperty('AND');
    expect(where.AND[1]).toEqual({
      OR: [{ teamId: TEAM }, { shares: { some: { teamId: TEAM } } }],
    });
  });

  it('lists recent requests without leaking an email, and drops cancelled runs', async () => {
    const { prisma, res } = await get({
      activity: [
        runRow({
          id: 'x',
          launchedBy: { email: 'ada@example.test', name: 'Ada' },
          status: 'FAILED',
        }),
        runRow({ id: 'cancelled', status: 'CANCELLED', workRequestId: 'w9' }),
        runRow({
          _count: { humanSteps: 1 },
          id: 'waiting',
          status: 'RUNNING',
          workRequestId: 'w8',
        }),
        runRow({ id: 'dup', status: 'SUCCESS' }),
      ],
      controlledRunIds: ['waiting'],
      teamRole: 'ENGINEER',
    });
    const { data } = res.json();
    expect(data.activity.map((a: { runId: string }) => a.runId)).toEqual(['x', 'waiting']);
    expect(data.activity.map((a: { state: string }) => a.state)).toEqual(['failed', 'attention']);
    expect(data.activity[0]).toMatchObject({
      launchedByName: 'Ada',
      repoName: 'acme/api',
      title: 'Add endpoint',
    });
    expect(res.body).not.toContain('ada@example.test');
    const activityQuery = prisma.workflowRun.findMany.mock.calls
      .map((c) => c[0])
      .find((a) => a.take === 50);
    expect(JSON.stringify(activityQuery?.select)).not.toContain('email');
    expect(JSON.stringify(prisma.team.findUnique.mock.calls[0][0])).not.toContain('email');
  });

  it('does not call a run needs-attention for a step the caller can see but not answer', async () => {
    // A sharee (carol): the run shows a pending step, but the control filter finds none she can
    // answer, so the feed agrees with `/requests?state=attention`, which excludes it.
    const { prisma, res } = await get({
      activity: [runRow({ _count: { humanSteps: 1 }, id: 'visible-only', status: 'RUNNING' })],
      controlledRunIds: [],
      teamRole: 'ENGINEER',
    });
    expect(res.json().data.activity[0].state).toBe('active');
    const query = prisma.workflowHumanStep.findMany.mock.calls
      .map((c) => c[0])
      .find((a) => !('run' in a.select));
    // The control filter's marks: an unanswered, unexpired, pending step, ANDed with the run ids.
    expect(JSON.stringify(query?.where)).toContain('"humanApprovals":{"none"');
    expect(query?.where.AND.at(-1)).toEqual({ runId: { in: ['visible-only'] } });
  });

  describe('budget', () => {
    it('is null when the org has no cap', async () => {
      const { prisma, res } = await get({ orgCapCents: null, teamRole: 'ENGINEER' });
      expect(res.json().data.budget).toBeNull();
      expect(prisma.organization.findMany).toHaveBeenCalledTimes(1);
    });

    it('gives an ENGINEER a state and a percentage and no dollar figure anywhere', async () => {
      const { res } = await get({ orgCapCents: 100_000, orgSpendUsd: 450, teamRole: 'ENGINEER' });
      const { data } = res.json();
      expect(data.budget).toEqual({
        alertThresholdPercent: 80,
        percentUsed: 45,
        scope: 'org',
        state: expect.stringMatching(/^(ok|alert|projected_over)$/),
      });
      expect(res.body).not.toMatch(/usd|cents|100000|450/i);
    });

    it('reports over once the cap is spent', async () => {
      const { res } = await get({ orgCapCents: 1000, orgSpendUsd: 11, teamRole: 'LEAD' });
      expect(res.json().data.budget).toMatchObject({ percentUsed: 110, state: 'over' });
    });

    it("reads only the team's own org", async () => {
      const { prisma } = await get({ orgCapCents: 1000, orgSpendUsd: 1, teamRole: 'ENGINEER' });
      expect(prisma.organization.findMany.mock.calls[0][0].where).toEqual({
        id: { in: ['org-1'] },
      });
    });
  });
});
