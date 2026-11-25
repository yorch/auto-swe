import { randomBytes } from 'node:crypto';
import { mintCampaignToken } from '@auto-swe/shared/lib/campaignTokenKey';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { campaignRoutes } from './campaigns.js';

vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

const settings = vi.hoisted(() => ({
  disabledTeams: new Set<string>(),
  maxTargets: 25,
}));
vi.mock('@auto-swe/shared/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@auto-swe/shared/config')>();
  return {
    ...original,
    resolveSetting: async (key: string, ctx?: { teamId?: string }) => {
      if (key === 'workflow.campaignsEnabled') {
        return !settings.disabledTeams.has(ctx?.teamId ?? '');
      }
      if (key === 'workflow.campaignMaxTargets') {
        return settings.maxTargets;
      }
      throw new Error(`unexpected setting ${key}`);
    },
  };
});

vi.mock('@auto-swe/shared/lib/systemConfig', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveGitHubBaseUrl: async () => 'https://github.com',
  resolveWorkflowDefaults: async () => ({ branchPrefix: 'auto' }),
}));

const push = vi.hoisted(() => ({
  result: { ok: true } as { ok: true } | { ok: false; reason: string },
}));
vi.mock('../lib/orchestrationAccess.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkPushPermission: async () => push.result,
}));

// ── Fixtures ──

const U = (n: number) => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`;
const CAMPAIGN = U(1);
const TEAM_1 = '00000000-0000-4000-8000-0000000000a1';
const TEAM_2 = '00000000-0000-4000-8000-0000000000a2';
const TEAM_3 = '00000000-0000-4000-8000-0000000000a3';
const REPO_A = '00000000-0000-4000-8000-00000000000a';
const REPO_B = '00000000-0000-4000-8000-00000000000b';
const REPO_C = '00000000-0000-4000-8000-00000000000c';
const REPO_X = '00000000-0000-4000-8000-00000000000d';
const REPO_GONE = '00000000-0000-4000-8000-0000000000ff';
const T_A = U(11);
const T_B = U(12);
const T_C = U(13);

const TEAMS: Record<string, { name: string; orgId: string }> = {
  [TEAM_1]: { name: 'alpha-team', orgId: 'org-1' },
  [TEAM_2]: { name: 'beta-team', orgId: 'org-1' },
  [TEAM_3]: { name: 'gamma-team', orgId: 'org-2' },
};
const REPOS: Record<string, { teamId: string; repoName: string; isActive?: boolean }> = {
  [REPO_A]: { repoName: 'alpha', teamId: TEAM_1 },
  [REPO_B]: { repoName: 'beta', teamId: TEAM_2 },
  [REPO_C]: { repoName: 'charlie', teamId: TEAM_1 },
  [REPO_X]: { repoName: 'xray', teamId: TEAM_3 },
};

type Row = Record<string, unknown> & { id: string };

describe('campaign control routes', () => {
  const app = Fastify();

  let currentSub = 'lead-1';
  let currentRole = 'LEAD';
  let teamRoles: Record<string, Record<string, string>> = {};
  let users: Record<string, { isActive: boolean; role: string }> = {};
  let orgMembers = new Set<string>();
  let campaigns: Row[] = [];
  let targets: Row[] = [];
  let attempts: Row[] = [];
  let runInputs: Row[] = [];
  let activeWorkflows: Row[] = [];
  let audits: Array<Record<string, unknown>> = [];
  let spendByWorkflow: Record<string, number> = {};
  let repoOverrides: Record<string, Record<string, unknown>> = {};
  let startFailure: Error | null = null;
  let controlFailure: Error | null = null;
  let beforeTargetUpdate: (() => void) | null = null;
  const startedRuns: Array<{ id: string; input: Record<string, unknown> }> = [];
  const signals: Array<{ id: string; name: string; payload: unknown }> = [];

  const isMember = (teamId: string, sub = currentSub) => teamRoles[teamId]?.[sub] !== undefined;

  beforeAll(async () => {
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: currentRole, sub: currentSub }),
    } as unknown as never);

    const repoDetail = (id: string, forSub = currentSub) => {
      const base = REPOS[id];
      if (!base) {
        return null;
      }
      const repo = { ...base, ...(repoOverrides[id] ?? {}) } as typeof base;
      const team = TEAMS[repo.teamId] as { name: string; orgId: string };
      return {
        githubApiUrl: null,
        githubUrl: null,
        id,
        installation: null,
        isActive: repo.isActive ?? true,
        organizationName: 'org',
        repoName: repo.repoName,
        scmProvider: (repoOverrides[id]?.scmProvider as string | undefined) ?? 'github',
        shares: [],
        team: {
          id: repo.teamId,
          isActive: true,
          memberships: isMember(repo.teamId, forSub) ? [{ userId: forSub }] : [],
          monthlyBudgetUsdCents: null,
          name: team.name,
          organization: { id: team.orgId, isActive: true, monthlyBudgetUsdCents: null },
          orgId: team.orgId,
        },
        teamId: repo.teamId,
        type: 'git_repo',
      };
    };

    const reachable = (connection: unknown) => {
      const and = (connection as { AND?: Array<Record<string, unknown>> }).AND;
      if (!Array.isArray(and) || and.length !== 2) {
        throw new Error(`unrecognised repository predicate: ${JSON.stringify(connection)}`);
      }
    };

    const matchCampaign = (c: Row, where: Record<string, unknown>) => {
      const {
        id,
        ownerTeamId,
        state,
        OR,
        targets: targetsFilter,
        ...rest
      } = where as {
        id?: string;
        targets?: { none: { brief: null } };
        ownerTeamId?: string;
        state?: string | { in?: string[]; notIn?: string[] };
        launchedById?: string | null;
        OR?: Array<Record<string, unknown>>;
      };
      const { launchedById, ...unknown } = rest;
      if (Object.keys(unknown).length > 0) {
        throw new Error(`unrecognised Campaign where: ${JSON.stringify(unknown)}`);
      }
      if (id && c.id !== id) {
        return false;
      }
      if (targetsFilter && targets.some((t) => t.campaignId === c.id && t.brief == null)) {
        return false;
      }
      if (ownerTeamId && c.ownerTeamId !== ownerTeamId) {
        return false;
      }
      if (launchedById !== undefined && c.launchedById !== launchedById) {
        return false;
      }
      if (typeof state === 'string' && c.state !== state) {
        return false;
      }
      if (state && typeof state === 'object') {
        if (state.in && !state.in.includes(c.state as string)) {
          return false;
        }
        if (state.notIn?.includes(c.state as string)) {
          return false;
        }
      }
      if (!OR) {
        return true;
      }
      return OR.some((term) => {
        if ('ownerTeam' in term) {
          return isMember(c.ownerTeamId as string);
        }
        if ('targets' in term) {
          reachable((term.targets as { some: { connection: unknown } }).some.connection);
          return targets.some(
            (t) => t.campaignId === c.id && t.connectionId && isMember(t.teamId as string)
          );
        }
        throw new Error(`unrecognised OR term: ${JSON.stringify(term)}`);
      });
    };

    const matchTarget = (t: Row, where: Record<string, unknown>) => {
      const { campaignId, id, state, teamId, connection, brief, ...rest } = where as {
        brief?: null;
        campaignId?: string;
        id?: string;
        state?: string | { in: string[] };
        teamId?: string;
        connection?: unknown;
      };
      if (Object.keys(rest).length > 0) {
        throw new Error(`unrecognised CampaignTarget where: ${JSON.stringify(rest)}`);
      }
      if (brief === null && t.brief != null) {
        return false;
      }
      if (campaignId && t.campaignId !== campaignId) {
        return false;
      }
      if (id && t.id !== id) {
        return false;
      }
      if (teamId && t.teamId !== teamId) {
        return false;
      }
      if (typeof state === 'string' && t.state !== state) {
        return false;
      }
      if (state && typeof state === 'object' && !state.in.includes(t.state as string)) {
        return false;
      }
      if (connection) {
        reachable(connection);
        return !!t.connectionId && isMember(t.teamId as string);
      }
      return true;
    };

    const pick = (row: Record<string, unknown>, select?: Record<string, unknown>) =>
      select
        ? Object.fromEntries(
            Object.entries(select)
              .filter(([, v]) => v)
              .map(([k]) => [k, row[k]])
          )
        : { ...row };

    const withRelations = (c: Row) => ({
      ...c,
      createdBy: c.createdById ? { id: c.createdById, name: 'Creator' } : null,
      ownerTeam: { id: c.ownerTeamId, name: TEAMS[c.ownerTeamId as string]?.name },
    });

    const prismaMock = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [{ id: 'locked' }],
      $transaction: async (arg: unknown) =>
        typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg as Promise<unknown>[]),
      activeWorkflow: {
        aggregate: async (args: { where: { temporalWorkflowId: { in: string[] } } }) => ({
          _sum: {
            costUsdAccrued: args.where.temporalWorkflowId.in.reduce(
              (sum, id) => sum + (spendByWorkflow[id] ?? 0),
              0
            ),
          },
        }),
        create: async (args: { data: Row }) => {
          const row = { ...args.data, id: `aw-${activeWorkflows.length + 1}` };
          activeWorkflows.push(row);
          return row;
        },
        delete: async (args: { where: { id: string } }) => {
          activeWorkflows = activeWorkflows.filter((a) => a.id !== args.where.id);
        },
        findMany: async () => [],
      },
      campaign: {
        create: async (args: { data: Row }) => {
          campaigns.push({ ...args.data });
          return args.data;
        },
        findFirst: async (args: {
          where: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) => {
          const row = campaigns.find((c) => matchCampaign(c, args.where));
          return row ? pick(withRelations(row), args.select) : null;
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const rows = campaigns.filter((c) => matchCampaign(c, args.where));
          for (const row of rows) {
            Object.assign(row, args.data);
          }
          return { count: rows.length };
        },
      },
      campaignAttempt: {
        aggregate: async (args: { where: { targetId: string } }) => ({
          _max: {
            n: attempts
              .filter((a) => a.targetId === args.where.targetId)
              .reduce<number | null>((max, a) => Math.max(max ?? 0, a.n as number), null),
          },
        }),
        create: async (args: { data: Row }) => {
          const row = { ...args.data, id: `att-${attempts.length + 1}`, runId: null };
          attempts.push(row);
          return row;
        },
        deleteMany: async (args: { where: { id: string } }) => {
          attempts = attempts.filter((a) => a.id !== args.where.id);
          return { count: 1 };
        },
        findFirst: async (args: { where: { childWorkflowId: string; targetId: string } }) =>
          attempts.find(
            (a) =>
              a.childWorkflowId === args.where.childWorkflowId && a.targetId === args.where.targetId
          ) ?? null,
        findMany: async (args: {
          where: { startedAt?: { gte: Date }; target?: unknown; targetId?: unknown };
        }) =>
          attempts.filter(
            (a) =>
              !args.where.startedAt ||
              (a.startedAt as Date).getTime() >= args.where.startedAt.gte.getTime()
          ),
      },
      campaignProposal: { findMany: async () => [] },
      campaignTarget: {
        count: async (args: { where: Record<string, unknown> }) =>
          targets.filter((t) => matchTarget(t, args.where)).length,
        createMany: async (args: { data: Row[] }) => {
          for (const d of args.data) {
            targets.push({
              brief: null,
              dependsOn: [],
              regressions: 0,
              state: 'PENDING',
              ...d,
            });
          }
          return { count: args.data.length };
        },
        findFirst: async (args: {
          where: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) => {
          const row = targets.find((t) => matchTarget(t, args.where));
          return row ? pick(row, args.select) : null;
        },
        findMany: async (args: {
          where: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) =>
          targets
            .filter((t) => matchTarget(t, args.where))
            .sort((a, b) => (a.position as number) - (b.position as number))
            .map((t) => pick(t, args.select)),
        groupBy: async () => [],
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          beforeTargetUpdate?.();
          const rows = targets.filter((t) => matchTarget(t, args.where));
          for (const row of rows) {
            Object.assign(row, args.data);
          }
          return { count: rows.length };
        },
      },
      configAuditLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          audits.push(args.data);
          return args.data;
        },
      },
      connection: {
        // The memberships come back for the user the query's select names: the person asking, or
        // the launcher the worker acts as.
        findMany: async (args: {
          select?: { team?: { select?: { memberships?: { where?: { userId?: string } } } } };
          where: { id: { in: string[] } };
        }) =>
          args.where.id.in.flatMap((id) => {
            const detail = repoDetail(
              id,
              args.select?.team?.select?.memberships?.where?.userId ?? currentSub
            );
            return detail ? [detail] : [];
          }),
        findUnique: async (args: { where: { id: string } }) => repoDetail(args.where.id),
      },
      organizationMembership: {
        findMany: async () => [],
        findUnique: async (args: { where: { userId_orgId: { orgId: string; userId: string } } }) =>
          orgMembers.has(`${args.where.userId_orgId.userId}:${args.where.userId_orgId.orgId}`)
            ? { ...args.where.userId_orgId }
            : null,
      },
      orgMonthlyUsage: { findUnique: async () => null },
      pullRequest: { findMany: async () => [] },
      runInput: {
        create: async (args: { data: Row }) => {
          if (
            args.data.idempotencyKey &&
            runInputs.some(
              (r) =>
                r.idempotencyKey === args.data.idempotencyKey &&
                r.requestedById === args.data.requestedById
            )
          ) {
            throw Object.assign(new Error('unique'), { code: 'P2002' });
          }
          runInputs.push({ ...args.data });
          return args.data;
        },
        delete: async (args: { where: { id: string } }) => {
          runInputs = runInputs.filter((r) => r.id !== args.where.id);
        },
        findFirst: async (args: { where: { idempotencyKey: string; requestedById: string } }) => {
          const row = runInputs.find(
            (r) =>
              r.idempotencyKey === args.where.idempotencyKey &&
              r.requestedById === args.where.requestedById
          );
          return row
            ? {
                activeWorkflows: activeWorkflows
                  .filter((a) => a.workRequestId === row.id)
                  .map((a) => ({
                    assignedBranch: a.assignedBranch,
                    temporalWorkflowId: a.temporalWorkflowId,
                  })),
              }
            : null;
        },
        findUnique: async (args: { where: { id: string } }) => {
          const row = runInputs.find((r) => r.id === args.where.id);
          if (row) {
            return row;
          }
          return campaigns.some((c) => c.workRequestId === args.where.id)
            ? { requestPayload: JSON.stringify({ budget: 'LARGE' }) }
            : null;
        },
      },
      team: {
        findMany: async (args: { where: { id: { in: string[] } } }) =>
          args.where.id.in.flatMap((id) =>
            TEAMS[id] ? [{ id, isActive: true, orgId: TEAMS[id].orgId }] : []
          ),
        findUnique: async (args: { where: { id: string } }) => {
          const team = TEAMS[args.where.id];
          return team
            ? { id: args.where.id, isActive: true, name: team.name, orgId: team.orgId }
            : null;
        },
      },
      teamMembership: {
        findMany: async (args: { where: { teamId: { in: string[] }; userId: string } }) =>
          args.where.teamId.in.flatMap((teamId) => {
            const role = teamRoles[teamId]?.[args.where.userId];
            return role ? [{ role, teamId }] : [];
          }),
        findUnique: async (args: {
          where: { userId_teamId: { teamId: string; userId: string } };
        }) => {
          const { teamId, userId } = args.where.userId_teamId;
          const role = teamRoles[teamId]?.[userId];
          return role ? { role } : null;
        },
      },
      user: {
        findUnique: async (args: { where: { id: string } }) => {
          const user = users[args.where.id];
          return user ? { id: args.where.id, ...user } : null;
        },
      },
      workflowRun: { findMany: async () => [] },
      workflowTemplate: {
        findFirst: async () => ({ activeVersion: 7, id: 'tpl-default', isDefault: true }),
      },
    };

    app.decorate('prisma', prismaMock as unknown as never);
    app.decorate('temporal', {
      cancelWorkflow: async () => {},
      signalCampaignCancel: async () => 'signalled',
      signalCampaignWorkflow: async (id: string, name: string, payload: unknown) => {
        if (controlFailure) {
          throw controlFailure;
        }
        signals.push({ id, name, payload });
        return 'signalled';
      },
      startRunnableWorkflow: async (id: string, input: Record<string, unknown>) => {
        if (startFailure) {
          throw startFailure;
        }
        startedRuns.push({ id, input });
      },
    } as unknown as never);

    await app.register(campaignRoutes, { prefix: '/api/v1/campaigns' });
    await app.ready();
  });

  afterAll(() => app.close());

  const campaignRow = (extra: Record<string, unknown> = {}): Row => ({
    budgetUsd: null,
    createdById: 'creator-1',
    description: 'Raise lodash',
    gate: 'OPENED',
    id: CAMPAIGN,
    launchedById: 'launcher-1',
    maxOpenPullRequests: 2,
    maxParallel: 2,
    name: 'lodash',
    orgId: 'org-1',
    ownerTeamId: TEAM_1,
    pausedReason: null,
    plan: 'UNIFORM',
    recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
    recipeRef: 'npm-dependency@2',
    state: 'ACTIVE',
    templateId: 'tpl-campaign',
    templateVersion: 3,
    temporalWorkflowId: `campaign-${CAMPAIGN}`,
    workflowKind: 'RECONCILER',
    workRequestId: 'wr-campaign',
    ...extra,
  });
  const targetRow = (id: string, connectionId: string, position: number, extra = {}): Row => ({
    brief: null,
    campaignId: CAMPAIGN,
    connectionId,
    dependsOn: [],
    id,
    position,
    regressions: 0,
    repoLabel: `org/${REPOS[connectionId]?.repoName}`,
    state: 'PENDING',
    teamId: REPOS[connectionId]?.teamId,
    ...extra,
  });
  const campaign = () => campaigns[0] as Row;
  const target = (id: string) => targets.find((t) => t.id === id) as Row;

  beforeEach(() => {
    currentSub = 'lead-1';
    currentRole = 'LEAD';
    // lead-1 leads teams 1 and 2; the launcher leads both too; creator-1 is only a member of team 1.
    teamRoles = {
      [TEAM_1]: {
        'creator-1': 'MEMBER',
        'launcher-1': 'LEAD',
        'lead-1': 'LEAD',
        'member-1': 'MEMBER',
      },
      [TEAM_2]: { 'launcher-1': 'LEAD', 'lead-1': 'LEAD' },
      [TEAM_3]: {},
    };
    users = {
      'launcher-1': { isActive: true, role: 'LEAD' },
      'lead-1': { isActive: true, role: 'LEAD' },
    };
    orgMembers = new Set(['launcher-1:org-1', 'lead-1:org-1', 'creator-1:org-1', 'member-1:org-1']);
    campaigns = [campaignRow()];
    targets = [targetRow(T_A, REPO_A, 0), targetRow(T_B, REPO_B, 1)];
    attempts = [];
    runInputs = [];
    activeWorkflows = [];
    audits = [];
    spendByWorkflow = {};
    repoOverrides = {};
    startedRuns.length = 0;
    signals.length = 0;
    startFailure = null;
    controlFailure = null;
    beforeTargetUpdate = null;
    push.result = { ok: true };
    settings.disabledTeams = new Set();
    settings.maxTargets = 25;
  });

  const as = (sub: string, role = 'ENGINEER') => {
    currentSub = sub;
    currentRole = role;
  };
  const auth = { authorization: 'Bearer test-token' };
  const call = (method: 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({
      headers: auth,
      method,
      ...(payload ? { payload } : {}),
      url: `/api/v1/campaigns${url}`,
    });
  const body = (res: { payload: string }) => JSON.parse(res.payload);

  // ── Confirm ──

  describe('POST /:id/confirm', () => {
    beforeEach(() => {
      campaigns = [campaignRow({ plan: 'PLANNED', state: 'PLANNING' })];
      for (const t of targets) {
        t.brief = `Change ${t.repoLabel}`;
      }
    });

    it('refuses to confirm while any target has no brief (the planner has not finished)', async () => {
      as('launcher-1');
      target(T_B).brief = null;
      const res = await call('POST', `/${CAMPAIGN}/confirm`);
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('CAMPAIGN_PLAN_NOT_READY');
      expect(campaign().state).toBe('PLANNING');
      expect(signals).toHaveLength(0);
    });

    it('does not confirm when a brief goes missing between the check and the write', async () => {
      as('launcher-1');
      const real = (app.prisma as unknown as { campaignTarget: { count: () => Promise<number> } })
        .campaignTarget;
      const original = real.count;
      real.count = async () => {
        // The check sees a complete plan; a target without a brief lands before the write.
        target(T_B).brief = null;
        return 0;
      };
      try {
        const res = await call('POST', `/${CAMPAIGN}/confirm`);
        expect(res.statusCode).toBe(409);
        expect(body(res).error.code).toBe('CAMPAIGN_PLAN_NOT_READY');
        expect(campaign().state).toBe('PLANNING');
      } finally {
        real.count = original;
      }
    });

    it('moves PLANNING to ACTIVE for the launcher only, and signals the reconciler', async () => {
      as('lead-1');
      const refused = await call('POST', `/${CAMPAIGN}/confirm`);
      expect(refused.statusCode).toBe(403);
      expect(campaign().state).toBe('PLANNING');

      as('launcher-1');
      const res = await call('POST', `/${CAMPAIGN}/confirm`);
      expect(res.statusCode).toBe(200);
      expect(body(res).data).toEqual({ id: CAMPAIGN, pausedReason: null, state: 'ACTIVE' });
      expect(campaign().state).toBe('ACTIVE');
      expect(signals).toEqual([
        { id: `campaign-${CAMPAIGN}`, name: 'campaignControl', payload: { action: 'confirm' } },
      ]);
      expect(audits.at(-1)).toMatchObject({
        action: 'UPDATE',
        actorId: 'launcher-1',
        beforeJson: { state: 'PLANNING' },
      });
    });

    it('is correct without the signal: the row is the change', async () => {
      as('launcher-1');
      controlFailure = new Error('temporal down');
      const res = await call('POST', `/${CAMPAIGN}/confirm`);
      expect(res.statusCode).toBe(200);
      expect(campaign().state).toBe('ACTIVE');
    });

    it('refuses a campaign that is not waiting to be confirmed, and one the caller cannot see', async () => {
      as('launcher-1');
      campaign().state = 'ACTIVE';
      const res = await call('POST', `/${CAMPAIGN}/confirm`);
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('CAMPAIGN_NOT_PLANNING');
      as('stranger');
      expect((await call('POST', `/${CAMPAIGN}/confirm`)).statusCode).toBe(404);
    });

    it('refuses a legacy campaign', async () => {
      as('launcher-1');
      campaign().workflowKind = 'LEGACY';
      expect(body(await call('POST', `/${CAMPAIGN}/confirm`)).error.code).toBe(
        'CAMPAIGN_NOT_RECONCILED'
      );
    });
  });

  // ── Pause and resume ──

  describe('POST /:id/pause and /resume', () => {
    it('lets the creator, an owning-team LEAD and an ADMIN pause; a plain member may not', async () => {
      as('member-1');
      expect((await call('POST', `/${CAMPAIGN}/pause`)).statusCode).toBe(403);
      expect(campaign().state).toBe('ACTIVE');

      for (const [sub, role] of [
        ['creator-1', 'ENGINEER'],
        ['lead-1', 'LEAD'],
        ['admin-1', 'ADMIN'],
      ] as const) {
        campaign().state = 'ACTIVE';
        as(sub, role);
        const res = await call('POST', `/${CAMPAIGN}/pause`);
        expect(res.statusCode, sub).toBe(200);
        expect(body(res).data).toEqual({ id: CAMPAIGN, pausedReason: 'manual', state: 'PAUSED' });
      }
      expect(signals.map((s) => s.payload)).toEqual([
        { action: 'pause' },
        { action: 'pause' },
        { action: 'pause' },
      ]);
    });

    it('records a manual pause and a note in the audit, and a second pause is a no-op', async () => {
      as('lead-1');
      await call('POST', `/${CAMPAIGN}/pause`, { note: 'waiting for the release freeze' });
      expect(campaign()).toMatchObject({ pausedReason: 'manual', state: 'PAUSED' });
      expect(audits.at(-1)).toMatchObject({
        actorId: 'lead-1',
        afterJson: {
          note: 'waiting for the release freeze',
          pausedReason: 'manual',
          state: 'PAUSED',
        },
        beforeJson: { state: 'ACTIVE' },
      });
      const again = await call('POST', `/${CAMPAIGN}/pause`);
      expect(again.statusCode).toBe(200);
      expect(audits.filter((a) => a.entityType === 'Campaign')).toHaveLength(1);
    });

    it('refuses to pause a planning, finished or cancelling campaign', async () => {
      as('lead-1');
      for (const state of ['PLANNING', 'COMPLETED', 'CANCELLING']) {
        campaign().state = state;
        const res = await call('POST', `/${CAMPAIGN}/pause`);
        expect(res.statusCode, state).toBe(409);
        expect(body(res).error.code).toBe('CAMPAIGN_NOT_PAUSABLE');
      }
    });

    it('does not resume a kill-switch pause while a target team has campaigns off, and says nothing of which', async () => {
      as('lead-1');
      campaign().state = 'PAUSED';
      campaign().pausedReason = 'disabled';
      settings.disabledTeams = new Set([TEAM_2]);
      const res = await call('POST', `/${CAMPAIGN}/resume`);
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('CAMPAIGNS_DISABLED');
      expect(res.payload).not.toContain(TEAM_2);
      expect(campaign().state).toBe('PAUSED');
      settings.disabledTeams = new Set();
      expect((await call('POST', `/${CAMPAIGN}/resume`)).statusCode).toBe(200);
    });

    it('resumes a paused campaign, and refuses while the setting is off or the launcher is gone', async () => {
      as('lead-1');
      campaign().state = 'PAUSED';
      campaign().pausedReason = 'disabled';
      settings.disabledTeams = new Set([TEAM_1]);
      const off = await call('POST', `/${CAMPAIGN}/resume`);
      expect(off.statusCode).toBe(409);
      expect(body(off).error.code).toBe('CAMPAIGNS_DISABLED');

      settings.disabledTeams = new Set();
      users['launcher-1'] = { isActive: false, role: 'LEAD' };
      const gone = await call('POST', `/${CAMPAIGN}/resume`);
      expect(gone.statusCode).toBe(409);
      expect(body(gone).error.code).toBe('LAUNCHER_UNAVAILABLE');
      expect(campaign().state).toBe('PAUSED');

      users['launcher-1'] = { isActive: true, role: 'LEAD' };
      const res = await call('POST', `/${CAMPAIGN}/resume`);
      expect(res.statusCode).toBe(200);
      expect(body(res).data).toEqual({ id: CAMPAIGN, pausedReason: null, state: 'ACTIVE' });
      expect(campaign()).toMatchObject({ pausedReason: null, state: 'ACTIVE' });
      expect(signals.at(-1)?.payload).toEqual({ action: 'resume' });
    });

    it('refuses to resume a campaign that is not paused', async () => {
      as('lead-1');
      const res = await call('POST', `/${CAMPAIGN}/resume`);
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('CAMPAIGN_NOT_PAUSED');
    });
  });

  // ── Take over ──

  describe('POST /:id/takeover', () => {
    it('hands the campaign to an owning-team LEAD, audited with both identities', async () => {
      as('lead-1');
      const res = await call('POST', `/${CAMPAIGN}/takeover`);
      expect(res.statusCode).toBe(200);
      expect(body(res).data).toMatchObject({
        id: CAMPAIGN,
        launchedById: 'lead-1',
        skippedTargetIds: [],
        state: 'ACTIVE',
      });
      expect(campaign().launchedById).toBe('lead-1');
      expect(campaign().launcherChangedAt).toBeInstanceOf(Date);
      expect(audits.at(-1)).toMatchObject({
        actorId: 'lead-1',
        afterJson: {
          launchedById: 'lead-1',
          previousLauncherId: 'launcher-1',
          takenOverById: 'lead-1',
        },
        beforeJson: { launchedById: 'launcher-1' },
      });
      expect(signals.at(-1)?.payload).toEqual({ action: 'takeover' });
    });

    it('never hands the campaign to its current launcher, nor to its creator who is not a LEAD', async () => {
      as('launcher-1', 'LEAD');
      const self = await call('POST', `/${CAMPAIGN}/takeover`);
      expect(self.statusCode).toBe(409);
      expect(body(self).error.code).toBe('ALREADY_LAUNCHER');

      as('creator-1');
      expect((await call('POST', `/${CAMPAIGN}/takeover`)).statusCode).toBe(403);
      expect(campaign().launchedById).toBe('launcher-1');
    });

    it('lets an ADMIN take over', async () => {
      as('admin-1', 'ADMIN');
      users['admin-1'] = { isActive: true, role: 'ADMIN' };
      expect((await call('POST', `/${CAMPAIGN}/takeover`)).statusCode).toBe(200);
      expect(campaign().launchedById).toBe('admin-1');
    });

    it('re-runs the launch decision for every unstarted target and SKIPS the ones the new person cannot reach', async () => {
      // lead-1 does not lead team 2, so beta cannot continue as them.
      teamRoles[TEAM_2] = { 'launcher-1': 'LEAD' };
      targets.push(targetRow(T_C, REPO_C, 2, { state: 'BLOCKED' }));
      target(T_A).state = 'RUNNING';
      as('lead-1');
      const res = await call('POST', `/${CAMPAIGN}/takeover`);
      expect(res.statusCode).toBe(200);
      expect(body(res).data.skippedTargetIds).toEqual([T_B]);
      expect(target(T_B)).toMatchObject({ state: 'SKIPPED' });
      expect(String(target(T_B).failureReason)).toContain('Skipped on take-over');
      // A running attempt finishes as it was; a reachable target continues.
      expect(target(T_A).state).toBe('RUNNING');
      expect(target(T_C).state).toBe('BLOCKED');
      expect(audits.at(-1)).toMatchObject({
        afterJson: { skippedTargetIds: [T_B], skippedTargets: 1 },
      });
    });

    it('resumes a campaign paused because its launcher was unavailable, and no other pause', async () => {
      campaign().state = 'PAUSED';
      campaign().pausedReason = 'launcher-unavailable';
      users['launcher-1'] = { isActive: false, role: 'LEAD' };
      as('lead-1');
      const res = await call('POST', `/${CAMPAIGN}/takeover`);
      expect(body(res).data).toMatchObject({ pausedReason: null, state: 'ACTIVE' });

      campaign().state = 'PAUSED';
      campaign().pausedReason = 'budget';
      campaign().launchedById = 'launcher-1';
      as('lead-1');
      const budget = await call('POST', `/${CAMPAIGN}/takeover`);
      expect(body(budget).data).toMatchObject({ pausedReason: 'budget', state: 'PAUSED' });
    });

    it('refuses a finished or cancelling campaign', async () => {
      as('lead-1');
      campaign().state = 'CANCELLING';
      expect((await call('POST', `/${CAMPAIGN}/takeover`)).statusCode).toBe(409);
    });
  });

  // ── Targets ──

  describe('POST /:id/targets', () => {
    it('appends the repositories the person may start work in and refuses the rest, with a reason', async () => {
      as('lead-1');
      const res = await call('POST', `/${CAMPAIGN}/targets`, {
        repoIds: [REPO_C, REPO_A, REPO_X, REPO_GONE],
      });
      expect(res.statusCode).toBe(200);
      const { added, refused } = body(res).data;
      expect(added).toEqual([
        { connectionId: REPO_C, id: expect.any(String), repoLabel: 'org/charlie' },
      ]);
      expect(refused.map((r: { connectionId: string }) => r.connectionId)).toEqual([
        REPO_A,
        REPO_X,
        REPO_GONE,
      ]);
      expect(refused[0].reason).toContain('already a target');
      expect(targets).toHaveLength(3);
      expect(targets[2]).toMatchObject({ connectionId: REPO_C, position: 2, state: 'PENDING' });
      expect(signals.at(-1)?.payload).toEqual({ action: 'addTargets' });
      expect(audits.at(-1)).toMatchObject({
        afterJson: { targetCount: 3 },
        beforeJson: { targetCount: 2 },
      });
    });

    it('counts new targets against the target limit', async () => {
      as('lead-1');
      settings.maxTargets = 2;
      const res = await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_C] });
      expect(body(res).data.added).toEqual([]);
      expect(body(res).data.refused[0].reason).toContain('target limit');
    });

    it('refuses a repository of another organization on a uniform campaign, and one whose team has campaigns off', async () => {
      teamRoles[TEAM_3] = { 'lead-1': 'LEAD' };
      orgMembers.add('lead-1:org-2');
      as('lead-1');
      const uniform = await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_X] });
      expect(body(uniform).data.refused[0].reason).toContain('own organization');
      // A planned campaign may take it.
      campaign().plan = 'PLANNED';
      const planned = await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_X] });
      expect(body(planned).data.added).toHaveLength(1);
      settings.disabledTeams = new Set([TEAM_1]);
      const off = await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_C] });
      expect(body(off).data.refused[0].reason).toContain('not enabled');
    });

    it('gives one generic reason for a repository the caller cannot lead, whatever else is wrong with it', async () => {
      // lead-1 leads no team that owns REPO_X (another organization): it must not learn that it is
      // in another organization, that its team has campaigns off, or that it is inactive.
      as('lead-1');
      const probe = async () =>
        body(await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_X, REPO_GONE] })).data
          .refused as Array<{ reason: string }>;
      const plain = await probe();
      expect(plain.map((r) => r.reason)).toEqual([plain[1]?.reason, plain[1]?.reason]);
      settings.disabledTeams = new Set([TEAM_3]);
      repoOverrides[REPO_X] = { isActive: false, scmProvider: 'gitlab' };
      expect((await probe()).map((r) => r.reason)).toEqual([plain[1]?.reason, plain[1]?.reason]);
      expect(plain[0]?.reason).not.toMatch(/organization|enabled|inactive|GitHub/);
    });

    it('refuses a plain member, a finished campaign and a legacy one', async () => {
      as('member-1');
      expect((await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_C] })).statusCode).toBe(
        403
      );
      as('lead-1');
      campaign().state = 'COMPLETED';
      expect((await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_C] })).statusCode).toBe(
        409
      );
      campaign().state = 'ACTIVE';
      campaign().workflowKind = 'LEGACY';
      const res = await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_C] });
      expect(body(res).error.code).toBe('CAMPAIGN_NOT_RECONCILED');
    });
  });

  describe('POST /:id/targets under the campaign lock', () => {
    const raw = () => app.prisma as unknown as { $queryRaw: () => Promise<unknown> };

    it('refuses, and inserts nothing, when the campaign settled before the lock was taken', async () => {
      as('lead-1');
      const original = raw().$queryRaw;
      raw().$queryRaw = async () => {
        campaign().state = 'COMPLETED';
        return [{ id: 'locked' }];
      };
      try {
        const res = await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_C] });
        expect(res.statusCode).toBe(409);
        expect(body(res).error.code).toBe('CAMPAIGN_NOT_ACTIVE');
        expect(targets).toHaveLength(2);
        expect(signals).toHaveLength(0);
      } finally {
        raw().$queryRaw = original;
      }
    });

    it('moves a MONITORING campaign back to ACTIVE with the insert', async () => {
      as('lead-1');
      campaign().state = 'MONITORING';
      const res = await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_C] });
      expect(res.statusCode).toBe(200);
      expect(targets).toHaveLength(3);
      expect(campaign().state).toBe('ACTIVE');
    });

    it('leaves an ACTIVE campaign as it is', async () => {
      as('lead-1');
      campaign().state = 'ACTIVE';
      await call('POST', `/${CAMPAIGN}/targets`, { repoIds: [REPO_C] });
      expect(campaign().state).toBe('ACTIVE');
    });
  });

  describe('POST /:id/targets/:targetId/retry', () => {
    it('moves a target that needs attention back to PENDING, for the creator, a LEAD or an ADMIN', async () => {
      for (const [sub, role] of [
        ['creator-1', 'ENGINEER'],
        ['lead-1', 'LEAD'],
      ] as const) {
        target(T_A).state = 'NEEDS_ATTENTION';
        target(T_A).failureReason = 'tests failed';
        as(sub, role);
        const res = await call('POST', `/${CAMPAIGN}/targets/${T_A}/retry`);
        expect(res.statusCode, sub).toBe(200);
        expect(body(res).data).toEqual({ id: T_A, state: 'PENDING' });
        expect(target(T_A).failureReason).toBeNull();
      }
      expect(signals.at(-1)?.payload).toEqual({ action: 'retry', targetId: T_A });
      expect(audits.at(-1)).toMatchObject({ afterJson: { state: 'PENDING', targetId: T_A } });
    });

    it('refuses a target in any other state, a plain member and an unreachable target', async () => {
      as('lead-1');
      const wrongState = await call('POST', `/${CAMPAIGN}/targets/${T_A}/retry`);
      expect(wrongState.statusCode).toBe(409);
      expect(body(wrongState).error.code).toBe('TARGET_NOT_RETRYABLE');
      as('member-1');
      target(T_A).state = 'NEEDS_ATTENTION';
      expect((await call('POST', `/${CAMPAIGN}/targets/${T_A}/retry`)).statusCode).toBe(403);
      // creator-1 is only in team 1: team 2's target is not theirs to see.
      as('creator-1');
      target(T_B).state = 'NEEDS_ATTENTION';
      const hidden = await call('POST', `/${CAMPAIGN}/targets/${T_B}/retry`);
      expect(hidden.statusCode).toBe(404);
      expect(target(T_B).state).toBe('NEEDS_ATTENTION');
    });
  });

  describe('DELETE /:id/targets/:targetId', () => {
    it('skips the target with the reason recorded, touching nothing on the host', async () => {
      as('lead-1');
      const res = await call('DELETE', `/${CAMPAIGN}/targets/${T_A}`, {
        reason: 'repo is archived soon',
      });
      expect(res.statusCode).toBe(200);
      expect(body(res).data).toEqual({ id: T_A, state: 'SKIPPED' });
      expect(target(T_A)).toMatchObject({
        failureReason: 'repo is archived soon',
        state: 'SKIPPED',
      });
      expect(signals.at(-1)?.payload).toEqual({ action: 'removeTarget', targetId: T_A });
    });

    it('works without a body, and refuses a running target and a plain member', async () => {
      as('lead-1');
      expect((await call('DELETE', `/${CAMPAIGN}/targets/${T_B}`)).statusCode).toBe(200);
      target(T_A).state = 'RUNNING';
      const running = await call('DELETE', `/${CAMPAIGN}/targets/${T_A}`);
      expect(running.statusCode).toBe(409);
      expect(body(running).error.code).toBe('TARGET_NOT_REMOVABLE');
      as('member-1');
      target(T_A).state = 'PENDING';
      expect((await call('DELETE', `/${CAMPAIGN}/targets/${T_A}`)).statusCode).toBe(403);
    });
  });

  // ── The worker's call ──

  describe('POST /:id/targets/:targetId/attempts', () => {
    const tokenFor = (targetId = T_A, campaignId = CAMPAIGN) =>
      mintCampaignToken({ call: 'startAttempt', campaignId, targetId });
    const attempt = (
      targetId = T_A,
      opts: { token?: string; key?: string; campaignId?: string } = {}
    ) =>
      app.inject({
        headers: {
          authorization: `Bearer ${opts.token ?? tokenFor(targetId, opts.campaignId)}`,
          ...(opts.key ? { 'idempotency-key': opts.key } : {}),
        },
        method: 'POST',
        url: `/api/v1/campaigns/${opts.campaignId ?? CAMPAIGN}/targets/${targetId}/attempts`,
      });
    const refusal = (res: { payload: string; statusCode: number }) => {
      expect(res.statusCode).toBe(409);
      return body(res).error.code as string;
    };

    it('starts the child run as the launcher: ledger rows, the attempt, the target RUNNING, branch and workflow id', async () => {
      const res = await attempt(T_A, { key: 'k-1' });
      expect(res.statusCode).toBe(201);
      const { data } = body(res);
      expect(data).toEqual({
        attemptId: 'att-1',
        branch: `auto/CAMPAIGN-${CAMPAIGN.replaceAll('-', '').slice(0, 12)}`,
        n: 1,
        runId: null,
        workflowId: `campaign-${CAMPAIGN}-${REPO_A}`,
      });
      expect(target(T_A)).toMatchObject({ failureReason: null, state: 'RUNNING' });
      expect(target(T_A).startedAt).toBeInstanceOf(Date);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ childWorkflowId: data.workflowId, n: 1, targetId: T_A });
      // The child is a run of the campaign's pinned template, acting as the LAUNCHER (not the token,
      // not whoever asked), carrying the recipe payload and the launch's budget tier.
      expect(startedRuns).toHaveLength(1);
      const started = startedRuns[0] as { id: string; input: Record<string, unknown> };
      expect(started.id).toBe(data.workflowId);
      expect(started.input).toMatchObject({
        request: {
          budgetTier: 'LARGE',
          connectionId: REPO_A,
          description: 'Raise lodash',
          launchedById: 'launcher-1',
          parentWorkflowId: `campaign-${CAMPAIGN}`,
          payload: {
            budget: 'LARGE',
            connectionId: REPO_A,
            packageName: 'lodash',
            recipe: 'npm-dependency@2',
            targetVersion: '4.17.21',
          },
          repoId: REPO_A,
        },
        templateId: 'tpl-campaign',
        templateVersion: 3,
      });
      expect(started.input.request).not.toHaveProperty('branchName');
      expect(runInputs[0]).toMatchObject({
        connectionId: REPO_A,
        idempotencyKey: `campaign-attempt:${CAMPAIGN}:${T_A}:k-1`,
        requestedById: 'launcher-1',
      });
      expect(activeWorkflows[0]).toMatchObject({
        assignedBranch: data.branch,
        parentWorkflowId: `campaign-${CAMPAIGN}`,
        repoId: REPO_A,
      });
      expect(audits.some((a) => a.entityType === 'WorkRequest' && a.actorId === 'launcher-1')).toBe(
        true
      );
    });

    it('rolls the attempt back when the target was removed after the checks (updateMany matched nothing)', async () => {
      beforeTargetUpdate = () => {
        // A concurrent remove commits between the unlocked read and the write.
        target(T_A).state = 'CANCELLED';
        beforeTargetUpdate = null;
      };
      const res = await attempt(T_A, { key: 'race' });
      expect(refusal(res)).toBe('TARGET_NOT_STARTABLE');
      expect(startedRuns).toHaveLength(0);
      expect(attempts).toHaveLength(0);
      expect(target(T_A).state).toBe('CANCELLED');
    });

    it('re-reads the target under the campaign lock', async () => {
      let locks = 0;
      const original = (app.prisma as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw;
      (app.prisma as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw = async () => {
        locks += 1;
        target(T_A).state = 'SKIPPED';
        return [{ id: 'locked' }];
      };
      try {
        const res = await attempt(T_A, { key: 'locked' });
        expect(refusal(res)).toBe('TARGET_NOT_STARTABLE');
        expect(locks).toBe(1);
        expect(startedRuns).toHaveLength(0);
        expect(attempts).toHaveLength(0);
      } finally {
        (app.prisma as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw = original;
      }
    });

    it('refuses when a take-over changed the launcher after the checks ran', async () => {
      const original = (app.prisma as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw;
      (app.prisma as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw = async () => {
        campaign().launchedById = 'lead-1';
        return [{ id: 'locked' }];
      };
      try {
        const res = await attempt(T_A, { key: 'takeover' });
        expect(refusal(res)).toBe('LAUNCHER_UNAVAILABLE');
        expect(startedRuns).toHaveLength(0);
        expect(attempts).toHaveLength(0);
      } finally {
        (app.prisma as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw = original;
      }
    });

    it('adopts an execution that already started under this id instead of rolling back', async () => {
      startFailure = Object.assign(new Error('already started'), {
        name: 'WorkflowExecutionAlreadyStartedError',
      });
      const res = await attempt(T_A, { key: 'ambiguous' });
      expect(res.statusCode).toBe(201);
      expect(target(T_A).state).toBe('RUNNING');
      expect(attempts).toHaveLength(1);
      expect(runInputs).toHaveLength(1);
      expect(activeWorkflows).toHaveLength(1);
    });

    it('still rolls back when the start definitely did not happen', async () => {
      startFailure = new Error('connection refused');
      const res = await attempt(T_A, { key: 'down' });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(target(T_A).state).toBe('PENDING');
      expect(attempts).toHaveLength(0);
    });

    it('answers a retried call with its first call’s attempt and starts nothing twice', async () => {
      const first = await attempt(T_A, { key: 'same' });
      expect(first.statusCode).toBe(201);
      const retry = await attempt(T_A, { key: 'same' });
      expect(retry.statusCode).toBe(200);
      expect(body(retry).data).toEqual(body(first).data);
      expect(startedRuns).toHaveLength(1);
      expect(attempts).toHaveLength(1);
    });

    it('starts attempt 2 on its own branch and workflow after a retry', async () => {
      attempts = [
        {
          childWorkflowId: `campaign-${CAMPAIGN}-${REPO_A}`,
          finishedAt: new Date(),
          id: 'att-0',
          n: 1,
          targetId: T_A,
        },
      ];
      const res = await attempt(T_A, { key: 'second' });
      expect(res.statusCode).toBe(201);
      const ticket = `CAMPAIGN-${CAMPAIGN.replaceAll('-', '').slice(0, 12)}`;
      expect(body(res).data).toMatchObject({
        branch: `auto/${ticket}-2`,
        n: 2,
        workflowId: `campaign-${CAMPAIGN}-${REPO_A}-2`,
      });
      const started = startedRuns[0] as unknown as { input: { request: Record<string, unknown> } };
      expect(started.input.request.branchName).toBe(`auto/${ticket}-2`);
    });

    it('runs a planned target’s own brief on its own team’s default template', async () => {
      campaign().plan = 'PLANNED';
      campaign().recipeRef = null;
      campaign().recipeParams = null;
      target(T_A).brief = 'Add the new client to alpha';
      const res = await attempt(T_A);
      expect(res.statusCode).toBe(201);
      const input = startedRuns[0]?.input as {
        templateId: string;
        templateVersion: number;
        request: Record<string, unknown>;
      };
      expect(input).toMatchObject({ templateId: 'tpl-default', templateVersion: 7 });
      expect(input.request.description).toBe('Add the new client to alpha');
      expect(input.request).not.toHaveProperty('payload');
    });

    it('is closed to everything but its campaign token', async () => {
      // A person's own token is admitted by requireAuth and refused by the route.
      const asUser = await app.inject({
        headers: auth,
        method: 'POST',
        url: `/api/v1/campaigns/${CAMPAIGN}/targets/${T_A}/attempts`,
      });
      expect(asUser.statusCode).toBe(403);
      expect(body(asUser).error.code).toBe('CAMPAIGN_TOKEN_REQUIRED');
      // A token for another target, another campaign, or a forged one.
      expect((await attempt(T_A, { token: tokenFor(T_B) })).statusCode).toBe(403);
      expect((await attempt(T_A, { token: tokenFor(T_A, U(99)) })).statusCode).toBe(403);
      expect((await attempt(T_A, { token: 'camp_garbage' })).statusCode).toBe(401);
      expect(startedRuns).toHaveLength(0);
      // And the token opens no other campaign route.
      const detail = await app.inject({
        headers: { authorization: `Bearer ${tokenFor()}` },
        method: 'GET',
        url: `/api/v1/campaigns/${CAMPAIGN}`,
      });
      expect(detail.statusCode).toBe(403);
      expect(body(detail).error.code).toBe('CAMPAIGN_TOKEN_NOT_ALLOWED');
    });

    it('step 1: CAMPAIGN_NOT_ACTIVE for a paused, planning, finished or legacy campaign; CAMPAIGNS_DISABLED', async () => {
      for (const state of ['PAUSED', 'PLANNING', 'COMPLETED', 'CANCELLING']) {
        campaign().state = state;
        expect(refusal(await attempt()), state).toBe('CAMPAIGN_NOT_ACTIVE');
      }
      campaign().state = 'ACTIVE';
      campaign().workflowKind = 'LEGACY';
      expect(refusal(await attempt())).toBe('CAMPAIGN_NOT_ACTIVE');
      campaign().workflowKind = 'RECONCILER';
      // A STARTING campaign is allowed.
      campaign().state = 'STARTING';
      expect((await attempt(T_A, { key: 'a' })).statusCode).toBe(201);
      target(T_A).state = 'PENDING';
      settings.disabledTeams = new Set([TEAM_2]);
      expect(refusal(await attempt(T_B))).toBe('CAMPAIGNS_DISABLED');
      settings.disabledTeams = new Set([TEAM_1]);
      expect(refusal(await attempt(T_B))).toBe('CAMPAIGNS_DISABLED');
    });

    it('step 2: LAUNCHER_UNAVAILABLE for a deactivated launcher, one who left the organization or lost the lead', async () => {
      users['launcher-1'] = { isActive: false, role: 'LEAD' };
      expect(refusal(await attempt())).toBe('LAUNCHER_UNAVAILABLE');
      users['launcher-1'] = { isActive: true, role: 'LEAD' };
      orgMembers.delete('launcher-1:org-1');
      expect(refusal(await attempt())).toBe('LAUNCHER_UNAVAILABLE');
      orgMembers.add('launcher-1:org-1');
      teamRoles[TEAM_1] = { ...teamRoles[TEAM_1], 'launcher-1': 'MEMBER' };
      expect(refusal(await attempt())).toBe('LAUNCHER_UNAVAILABLE');
      campaign().launchedById = null;
      expect(refusal(await attempt())).toBe('LAUNCHER_UNAVAILABLE');
      expect(startedRuns).toHaveLength(0);
    });

    it('step 3: TARGET_UNAVAILABLE for a repository that is gone, inactive or changed team; TARGET_NOT_STARTABLE', async () => {
      repoOverrides[REPO_A] = { isActive: false };
      expect(refusal(await attempt())).toBe('TARGET_UNAVAILABLE');
      repoOverrides[REPO_A] = { teamId: TEAM_2 };
      expect(refusal(await attempt())).toBe('TARGET_UNAVAILABLE');
      repoOverrides = {};
      target(T_A).connectionId = null;
      expect(refusal(await attempt())).toBe('TARGET_UNAVAILABLE');
      target(T_A).connectionId = REPO_A;
      for (const state of ['RUNNING', 'PR_OPENED', 'SATISFIED', 'SKIPPED', 'NEEDS_ATTENTION']) {
        target(T_A).state = state;
        expect(refusal(await attempt()), state).toBe('TARGET_NOT_STARTABLE');
      }
      // A target that does not belong to the campaign is not found.
      expect((await attempt(U(77), { token: tokenFor(U(77)) })).statusCode).toBe(404);
    });

    it('step 4: GATE_CLOSED while an upstream target has not opened its draft; open once it has', async () => {
      target(T_B).dependsOn = [T_A];
      expect(refusal(await attempt(T_B))).toBe('GATE_CLOSED');
      target(T_A).state = 'PR_OPENED';
      expect((await attempt(T_B, { key: 'b' })).statusCode).toBe(201);
    });

    it('step 4: a MERGED gate needs the upstream merged and satisfied', async () => {
      campaign().gate = 'MERGED';
      target(T_B).dependsOn = [T_A];
      target(T_A).state = 'PR_OPENED';
      expect(refusal(await attempt(T_B))).toBe('GATE_CLOSED');
      target(T_A).state = 'MERGED';
      // The recipe has a check, so a merge is not yet the end: the upstream must be satisfied.
      expect(refusal(await attempt(T_B))).toBe('GATE_CLOSED');
      target(T_A).state = 'SATISFIED';
      expect((await attempt(T_B, { key: 'c' })).statusCode).toBe(201);
    });

    it('step 4: MAX_PARALLEL and MAX_OPEN_PULL_REQUESTS, counted over the campaign’s own targets', async () => {
      targets.push(targetRow(T_C, REPO_C, 2));
      campaign().maxParallel = 1;
      target(T_B).state = 'RUNNING';
      expect(refusal(await attempt(T_A))).toBe('MAX_PARALLEL');
      target(T_B).state = 'PR_OPENED';
      campaign().maxParallel = 5;
      campaign().maxOpenPullRequests = 1;
      expect(refusal(await attempt(T_A))).toBe('MAX_OPEN_PULL_REQUESTS');
      campaign().maxOpenPullRequests = 2;
      // An earlier PENDING sibling does not hold the slot the worker asked this target to take.
      expect((await attempt(T_C, { key: 'late' })).statusCode).toBe(201);
    });

    it('step 4: a running attempt counts toward maxOpenPullRequests, since it will become a draft', async () => {
      campaign().maxParallel = 5;
      campaign().maxOpenPullRequests = 1;
      target(T_B).state = 'RUNNING';
      expect(refusal(await attempt(T_A))).toBe('MAX_OPEN_PULL_REQUESTS');
      campaign().maxOpenPullRequests = 2;
      expect((await attempt(T_A, { key: 'room' })).statusCode).toBe(201);
    });

    it('step 4 is decided under a row lock on the campaign', async () => {
      const queries: string[] = [];
      const original = (app.prisma as unknown as { $queryRaw: unknown }).$queryRaw;
      (app.prisma as unknown as { $queryRaw: unknown }).$queryRaw = async (
        strings: TemplateStringsArray
      ) => {
        queries.push(strings.join('?'));
        return [{ id: 'locked' }];
      };
      try {
        expect((await attempt(T_A)).statusCode).toBe(201);
      } finally {
        (app.prisma as unknown as { $queryRaw: unknown }).$queryRaw = original;
      }
      expect(queries.some((q) => /FROM campaigns WHERE id = \?::uuid FOR UPDATE/.test(q))).toBe(
        true
      );
    });

    it('step 5: LAUNCH_REFUSED when the launcher no longer passes the launch decision', async () => {
      // The launcher still leads the owning team but no longer leads beta's.
      teamRoles[TEAM_2] = {};
      const res = await attempt(T_B);
      expect(refusal(res)).toBe('LAUNCH_REFUSED');
      expect(body(res).error.message).toContain('no longer authorized');
      expect(startedRuns).toHaveLength(0);
    });

    it('step 5: PUSH_PERMISSION_REQUIRED when GitHub does not confirm push access', async () => {
      push.result = { ok: false, reason: 'GitHub reports no push access to this repository' };
      const res = await attempt();
      expect(refusal(res)).toBe('PUSH_PERMISSION_REQUIRED');
      expect(body(res).error.message).toContain('no push access');
      expect(target(T_A).state).toBe('PENDING');
    });

    it('step 5: BUDGET_EXCEEDED pauses the campaign at its monthly budget, counting this month only', async () => {
      campaign().budgetUsd = 100;
      attempts = [
        {
          childWorkflowId: 'old-month',
          id: 'old',
          n: 1,
          startedAt: new Date('2020-01-01'),
          targetId: T_B,
        },
        { childWorkflowId: 'this-month', id: 'now', n: 1, startedAt: new Date(), targetId: T_B },
      ];
      spendByWorkflow = { 'old-month': 500, 'this-month': 60 };
      expect((await attempt()).statusCode).toBe(201);
      target(T_A).state = 'PENDING';
      attempts = attempts.filter((a) => a.targetId === T_B);
      spendByWorkflow['this-month'] = 100;
      const res = await attempt(T_A, { key: 'over' });
      expect(refusal(res)).toBe('BUDGET_EXCEEDED');
      expect(campaign()).toMatchObject({ pausedReason: 'budget', state: 'PAUSED' });
      expect(audits.at(-1)).toMatchObject({
        afterJson: { pausedReason: 'budget', state: 'PAUSED' },
        beforeJson: { state: 'ACTIVE' },
      });
    });

    it('step 6: a run that fails to start leaves the attempt and the target as they were', async () => {
      startFailure = new Error('temporal unreachable');
      const res = await attempt(T_A, { key: 'fails' });
      expect(res.statusCode).toBe(500);
      expect(attempts).toHaveLength(0);
      expect(target(T_A).state).toBe('PENDING');
      expect(runInputs).toHaveLength(0);
      expect(activeWorkflows).toHaveLength(0);
      // The worker's retry starts a clean attempt 1.
      startFailure = null;
      const retry = await attempt(T_A, { key: 'fails' });
      expect(retry.statusCode).toBe(201);
      expect(body(retry).data.n).toBe(1);
    });

    it('refuses a target another call started while this one decided: no second attempt', async () => {
      const first = await attempt(T_A, { key: 'one' });
      expect(first.statusCode).toBe(201);
      // A different key for the same target while it runs is not a retry.
      expect(refusal(await attempt(T_A, { key: 'two' }))).toBe('TARGET_NOT_STARTABLE');
      expect(attempts).toHaveLength(1);
    });
  });
});
