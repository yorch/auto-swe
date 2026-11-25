import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { epicRoutes } from './epics.js';

vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

const settings = vi.hoisted(() => ({
  campaignsDisabled: new Set<string>(),
  maxTargets: 25,
  reconciler: true,
  unreadable: false,
}));
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSetting: async (key: string, ctx?: { teamId?: string }) => {
    if (settings.unreadable) {
      throw new Error('settings unavailable');
    }
    switch (key) {
      case 'workflow.campaignReconciler':
        return settings.reconciler;
      case 'workflow.campaignsEnabled':
        return !settings.campaignsDisabled.has(ctx?.teamId ?? '');
      case 'workflow.campaignMaxTargets':
        return settings.maxTargets;
      case 'workflow.campaignMaxParallelChildren':
        return 3;
      case 'workflow.campaignMaxOpenPullRequests':
        return 10;
      case 'workflow.campaignStaleAfterDays':
        return 14;
      case 'workflow.campaignRescanIntervalHours':
        return 24;
      case 'workflow.campaignLifetimeDays':
        return 90;
      default:
        throw new Error(`unexpected setting ${key}`);
    }
  },
}));

const TEAM_1 = '00000000-0000-4000-8000-0000000000a1';
const TEAM_2 = '00000000-0000-4000-8000-0000000000a2';
const REPO_A = '00000000-0000-4000-8000-00000000000a'; // team 1
const REPO_B = '00000000-0000-4000-8000-00000000000b'; // team 2
const TEAMS: Record<string, { name: string; orgId: string }> = {
  [TEAM_1]: { name: 'alpha-team', orgId: 'org-1' },
  [TEAM_2]: { name: 'beta-team', orgId: 'org-1' },
};
const REPOS: Record<string, { repoName: string; teamId: string }> = {
  [REPO_A]: { repoName: 'alpha', teamId: TEAM_1 },
  [REPO_B]: { repoName: 'beta', teamId: TEAM_2 },
};

type Row = Record<string, unknown> & { id: string };

describe('epics launched as campaigns', () => {
  const app = Fastify();
  let currentSub = 'lead-1';
  let currentRole = 'LEAD';
  let teamRoles: Record<string, Record<string, string>> = {};
  let campaigns: Row[] = [];
  let targets: Row[] = [];
  let runInputs: Row[] = [];
  let ledger: Row[] = [];
  let legacyRuns: Row[] = [];
  let audits: Array<Record<string, unknown>> = [];
  const started: Array<{ id: string; input: unknown }> = [];
  const startedLegacy: string[] = [];

  const isMember = (teamId: string) => teamRoles[teamId]?.[currentSub] !== undefined;

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: currentRole, sub: currentSub }),
    } as unknown as never);

    const repoDetail = (id: string) => {
      const repo = REPOS[id];
      if (!repo) {
        return null;
      }
      const team = TEAMS[repo.teamId] as { name: string; orgId: string };
      return {
        githubApiUrl: null,
        githubUrl: null,
        id,
        installation: null,
        isActive: true,
        organizationName: 'org',
        repoName: repo.repoName,
        scmProvider: 'github',
        shares: [],
        team: {
          id: repo.teamId,
          isActive: true,
          memberships: isMember(repo.teamId) ? [{ userId: currentSub }] : [],
          monthlyBudgetUsdCents: null,
          name: team.name,
          organization: { id: team.orgId, isActive: true, monthlyBudgetUsdCents: null },
          orgId: team.orgId,
        },
        teamId: repo.teamId,
        type: 'git_repo',
      };
    };
    const visible = (c: Row) =>
      currentRole === 'ADMIN' ||
      c.createdById === currentSub ||
      isMember(c.ownerTeamId as string) ||
      targets.some((t) => t.campaignId === c.id && isMember(t.teamId as string));
    const withRelations = (c: Row) => ({
      ...c,
      createdBy: { email: 'a@b.c', id: c.createdById, name: 'Creator' },
    });

    const prismaMock = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [{ id: 'locked' }],
      $transaction: async (arg: unknown) =>
        typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg as Promise<unknown>[]),
      activeWorkflow: {
        create: async (args: { data: Row }) => {
          if (ledger.some((r) => r.temporalWorkflowId === args.data.temporalWorkflowId)) {
            throw Object.assign(new Error('unique'), { code: 'P2002' });
          }
          ledger.push(args.data);
          return { ...args.data, id: `aw-${ledger.length}` };
        },
        delete: async (args: { where: { id: string } }) => {
          ledger = ledger.filter((_, i) => `aw-${i + 1}` !== args.where.id);
        },
        findMany: async () => [],
        findUnique: async (args: { where: { temporalWorkflowId: string } }) =>
          legacyRuns.find((r) => r.temporalWorkflowId === args.where.temporalWorkflowId) ?? null,
      },
      campaign: {
        count: async (args: { where: { plan: string } }) =>
          campaigns.filter((c) => c.plan === args.where.plan && visible(c)).length,
        create: async (args: { data: Row }) => {
          campaigns.push({ createdAt: new Date(), updatedAt: new Date(), ...args.data });
          return args.data;
        },
        findFirst: async (args: { where: { id: string; plan?: string }; select?: object }) => {
          const row = campaigns.find(
            (c) =>
              c.id === args.where.id &&
              (!args.where.plan || c.plan === args.where.plan) &&
              visible(c)
          );
          return row ? withRelations(row) : null;
        },
        findMany: async (args: { take: number; where: { plan: string } }) =>
          campaigns
            .filter((c) => c.plan === args.where.plan && visible(c))
            .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
            .slice(0, args.take)
            .map(withRelations),
      },
      campaignTarget: {
        createMany: async (args: { data: Row[] }) => {
          targets.push(...args.data.map((d) => ({ state: 'PENDING', ...d })));
          return { count: args.data.length };
        },
        findMany: async (args: { where: { campaignId: string } }) =>
          targets
            .filter((t) => t.campaignId === args.where.campaignId)
            .filter((t) => currentRole === 'ADMIN' || isMember(t.teamId as string))
            .map((t) => ({
              attempts: [],
              connection: {
                organizationName: 'org',
                repoName: REPOS[t.connectionId as string]?.repoName,
              },
              ...t,
            })),
        groupBy: async (args: { where: { campaignId: { in: string[] } } }) =>
          args.where.campaignId.in.map((id) => ({
            _count: { _all: targets.filter((t) => t.campaignId === id).length },
            campaignId: id,
          })),
      },
      configAuditLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          audits.push(args.data);
          return args.data;
        },
      },
      connection: {
        findMany: async (args: { where: { id: { in: string[] } } }) =>
          args.where.id.in.flatMap((id) => {
            const detail = repoDetail(id);
            return detail ? [detail] : [];
          }),
        findUnique: async (args: { where: { id: string } }) => repoDetail(args.where.id),
      },
      organizationMembership: {
        findMany: async () => [],
        findUnique: async (args: { where: { userId_orgId: object } }) => ({
          ...args.where.userId_orgId,
        }),
      },
      orgMonthlyUsage: { findUnique: async () => null },
      runInput: {
        count: async () => legacyRuns.length,
        create: async (args: { data: Row }) => {
          runInputs.push(args.data);
          return args.data;
        },
        delete: async (args: { where: { id: string } }) => {
          runInputs = runInputs.filter((r) => r.id !== args.where.id);
          campaigns = campaigns.filter((c) => c.workRequestId !== args.where.id);
          targets = [];
        },
        findFirst: async () => null,
        findMany: async () => [],
      },
      team: {
        findMany: async (args: { where: { id: { in: string[] } } }) =>
          args.where.id.in.flatMap((id) =>
            TEAMS[id] ? [{ id, isActive: true, orgId: TEAMS[id].orgId }] : []
          ),
      },
      teamMembership: {
        findMany: async (args: { where: { teamId: { in: string[] }; userId: string } }) =>
          args.where.teamId.in.flatMap((teamId) => {
            const role = teamRoles[teamId]?.[args.where.userId];
            return role ? [{ role, teamId }] : [];
          }),
      },
      user: {
        findUnique: async () => ({ id: currentSub, isActive: true, role: currentRole }),
      },
      workflowTemplate: {
        findFirst: async () => ({ activeVersion: 7, id: 'tpl-default', isDefault: true }),
      },
    };
    app.decorate('prisma', prismaMock as unknown as never);
    app.decorate('temporal', {
      startCampaignReconcilerWorkflow: async (id: string, input: unknown) => {
        started.push({ id, input });
      },
      startEpicWorkflow: async (id: string) => {
        startedLegacy.push(id);
      },
    } as unknown as never);
    await app.register(epicRoutes, { prefix: '/api/v1/epics' });
    await app.ready();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    currentSub = 'lead-1';
    currentRole = 'LEAD';
    teamRoles = { [TEAM_1]: { 'lead-1': 'LEAD' }, [TEAM_2]: { 'lead-1': 'LEAD' } };
    campaigns = [];
    targets = [];
    runInputs = [];
    ledger = [];
    legacyRuns = [];
    audits = [];
    started.length = 0;
    startedLegacy.length = 0;
    settings.reconciler = true;
    settings.campaignsDisabled = new Set();
    settings.maxTargets = 25;
    settings.unreadable = false;
  });

  const auth = { authorization: 'Bearer t' };
  const launch = (extra: Record<string, unknown> = {}) =>
    app.inject({
      headers: auth,
      method: 'POST',
      payload: {
        description: 'Move the client to v2',
        externalTicketId: 'PROD-7',
        repoIds: [REPO_A, REPO_B],
        ...extra,
      },
      url: '/api/v1/epics',
    });
  const body = (res: { payload: string }) => JSON.parse(res.payload);

  it('launches a PLANNED campaign in PLANNING, with an epic’s answer shape', async () => {
    const res = await launch();
    expect(res.statusCode).toBe(201);
    const { data } = body(res);
    expect(data).toMatchObject({
      epicWorkflowId: `campaign-${data.campaignId}`,
      externalTicketId: 'PROD-7',
      state: 'PLANNING',
    });
    expect(data.detailPath).toBe(`/epics/campaign-${data.campaignId}`);
    expect(campaigns[0]).toMatchObject({
      createdById: 'lead-1',
      gate: 'OPENED',
      launchedById: 'lead-1',
      name: 'PROD-7',
      orgId: 'org-1',
      ownerTeamId: TEAM_1,
      plan: 'PLANNED',
      state: 'PLANNING',
      templateId: 'tpl-default',
      workflowKind: 'RECONCILER',
    });
    // No recipe, no scope: the planner decides the work, and the repositories are the targets.
    expect(campaigns[0]).not.toHaveProperty('recipeRef');
    expect(campaigns[0]).not.toHaveProperty('scopeKind');
    expect(targets.map((t) => [t.connectionId, t.position, t.state])).toEqual([
      [REPO_A, 0, 'PENDING'],
      [REPO_B, 1, 'PENDING'],
    ]);
    expect(started).toEqual([
      {
        id: data.epicWorkflowId,
        input: { campaignId: data.campaignId, campaignWorkflowId: data.epicWorkflowId },
      },
    ]);
    expect(startedLegacy).toEqual([]);
    // A pinned template keeps it out of the legacy epic list's ledger shape.
    expect(runInputs[0]).toMatchObject({ isCrossRepo: true, templateId: 'tpl-default' });
    expect(audits.find((a) => a.entityType === 'Campaign')).toMatchObject({
      action: 'CREATE',
      actorId: 'lead-1',
    });
  });

  it('answers 409 EPIC_ALREADY_EXISTS for a second launch of the ticket, and for a legacy epic of it', async () => {
    expect((await launch()).statusCode).toBe(201);
    const again = await launch();
    expect(again.statusCode).toBe(409);
    expect(body(again).error.code).toBe('EPIC_ALREADY_EXISTS');
    expect(campaigns).toHaveLength(1);

    campaigns = [];
    targets = [];
    legacyRuns = [{ id: 'old', temporalWorkflowId: 'epic-PROD-7' }];
    expect(body(await launch()).error.code).toBe('EPIC_ALREADY_EXISTS');
    expect(campaigns).toHaveLength(0);
  });

  it('runs the legacy epic workflow when the reconciler is off, or its preconditions do not hold', async () => {
    settings.reconciler = false;
    expect((await launch()).statusCode).toBe(201);
    expect(startedLegacy).toEqual(['epic-PROD-7']);
    expect(campaigns).toHaveLength(0);

    startedLegacy.length = 0;
    runInputs = [];
    ledger = [];
    settings.reconciler = true;
    // Campaigns off for a target's team, more repositories than a campaign takes, settings unread.
    for (const arrange of [
      () => {
        settings.campaignsDisabled = new Set([TEAM_2]);
      },
      () => {
        settings.campaignsDisabled = new Set();
        settings.maxTargets = 1;
      },
      () => {
        settings.maxTargets = 25;
        settings.unreadable = true;
      },
    ]) {
      arrange();
      runInputs = [];
      ledger = [];
      startedLegacy.length = 0;
      const res = await launch();
      expect(res.statusCode).toBe(201);
      expect(startedLegacy).toEqual(['epic-PROD-7']);
    }
    expect(campaigns).toHaveLength(0);
  });

  it('refuses a launcher who does not lead every team, whichever workflow it would run', async () => {
    teamRoles[TEAM_2] = { 'lead-1': 'MEMBER' };
    const res = await launch();
    expect(res.statusCode).toBe(403);
    expect(campaigns).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  describe('reading them', () => {
    const seed = async () => {
      const res = await launch();
      return body(res).data as { campaignId: string; epicWorkflowId: string };
    };
    const list = (query = '') =>
      app.inject({ headers: auth, method: 'GET', url: `/api/v1/epics${query}` });

    it('lists the campaign beside legacy epics under the epic status words', async () => {
      const { epicWorkflowId, campaignId } = await seed();
      const res = await list();
      expect(res.statusCode).toBe(200);
      expect(body(res).data).toEqual([
        {
          campaignId,
          createdAt: expect.any(String),
          description: 'Move the client to v2',
          epicWorkflowId,
          externalTicketId: 'PROD-7',
          repoCount: 2,
          requestedBy: { email: 'a@b.c', id: 'lead-1', name: 'Creator' },
          status: 'PLANNING',
          updatedAt: expect.any(String),
          workRequestId: expect.any(String),
        },
      ]);
      expect(body(res).meta).toEqual({ limit: 50, offset: 0, total: 1 });
      (campaigns[0] as Row).state = 'ACTIVE';
      expect(body(await list()).data[0].status).toBe('FANNING_OUT');
    });

    it('hides it from someone who created it not, owns it not and reaches no target of it', async () => {
      await seed();
      currentSub = 'stranger';
      currentRole = 'ENGINEER';
      teamRoles = {};
      expect(body(await list()).data).toEqual([]);
      expect(body(await list()).meta.total).toBe(0);
    });

    it('reads the detail by its campaign workflow id, with its targets as children', async () => {
      const { epicWorkflowId, campaignId } = await seed();
      const res = await app.inject({
        headers: auth,
        method: 'GET',
        url: `/api/v1/epics/${epicWorkflowId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(body(res).data).toMatchObject({
        campaignId,
        epicWorkflowId,
        externalTicketId: 'PROD-7',
        state: 'PLANNING',
        status: 'PLANNING',
      });
      expect(
        body(res).data.children.map((c: { repoName: string; status: string }) => [
          c.repoName,
          c.status,
        ])
      ).toEqual([
        ['alpha', 'PENDING'],
        ['beta', 'PENDING'],
      ]);
    });

    it('answers 404 for a campaign the caller cannot see, and for a malformed campaign id', async () => {
      const { epicWorkflowId } = await seed();
      currentSub = 'stranger';
      currentRole = 'ENGINEER';
      teamRoles = {};
      const hidden = await app.inject({
        headers: auth,
        method: 'GET',
        url: `/api/v1/epics/${epicWorkflowId}`,
      });
      expect(hidden.statusCode).toBe(404);
      const malformed = await app.inject({
        headers: auth,
        method: 'GET',
        url: '/api/v1/epics/campaign-not-a-uuid',
      });
      expect(malformed.statusCode).toBe(404);
    });
  });
});
