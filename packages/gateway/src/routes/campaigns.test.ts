import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { campaignRoutes } from './campaigns.js';

// Org spend comes from the mock's `orgMonthlyUsage` row (see test/billingMock.ts).
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

// The three campaign settings come from a table a test edits; everything else keeps its default.
const settings = vi.hoisted(() => ({
  disabledTeams: new Set<string>(),
  maxParallel: 3,
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
      if (key === 'workflow.campaignMaxParallelChildren') {
        return settings.maxParallel;
      }
      throw new Error(`unexpected setting ${key}`);
    },
  };
});

// ── Fixtures ──

const TEAM_1 = '00000000-0000-4000-8000-0000000000a1'; // org-1, the usual owner
const TEAM_2 = '00000000-0000-4000-8000-0000000000a2'; // org-1
const TEAM_3 = '00000000-0000-4000-8000-0000000000a3'; // org-2

const REPO_A = '00000000-0000-4000-8000-00000000000a'; // team 1
const REPO_B = '00000000-0000-4000-8000-00000000000b'; // team 2
const REPO_X = '00000000-0000-4000-8000-00000000000c'; // team 3, another organization
const MISSING = '00000000-0000-4000-8000-0000000000ff';

const TEAMS: Record<string, { name: string; orgId: string }> = {
  [TEAM_1]: { name: 'alpha-team', orgId: 'org-1' },
  [TEAM_2]: { name: 'beta-team', orgId: 'org-1' },
  [TEAM_3]: { name: 'gamma-team', orgId: 'org-2' },
};

const REPOS: Record<string, { teamId: string; repoName: string }> = {
  [REPO_A]: { repoName: 'alpha', teamId: TEAM_1 },
  [REPO_B]: { repoName: 'beta', teamId: TEAM_2 },
  [REPO_X]: { repoName: 'gamma', teamId: TEAM_3 },
};

const TEMPLATE = {
  activeVersion: 3,
  id: 'tpl-campaign',
  inputSchema: {
    properties: {
      budget: { enum: ['STANDARD', 'LARGE', 'EPIC'], type: 'string' },
      connectionId: { connectionType: 'git_repo', type: 'connection' },
      packageName: { maxLength: 255, pattern: '[A-Za-z0-9@][A-Za-z0-9._~/-]*', type: 'string' },
      recipe: { enum: ['npm-dependency@1', 'go-module@1'], type: 'string' },
      targetVersion: { maxLength: 128, pattern: '[v0-9][0-9A-Za-z.+-]*', type: 'string' },
    },
    required: ['connectionId'],
    type: 'object',
  },
};

interface CampaignRow {
  id: string;
  name: string;
  description: string;
  ownerTeamId: string;
  orgId: string;
  recipeRef: string | null;
  recipeParams: unknown;
  templateId: string;
  templateVersion: number;
  maxParallel: number;
  state: string;
  temporalWorkflowId: string;
  workRequestId: string;
  createdById: string | null;
  cancelledById: string | null;
  cancelledAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TargetRow {
  id: string;
  campaignId: string;
  connectionId: string | null;
  teamId: string;
  repoLabel: string;
  position: number;
  state: string;
  path: string | null;
  verification: string | null;
  childWorkflowId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  failureReason: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

type Where = Record<string, unknown>;

/**
 * `reachableConnections(...)` and its inline spelling: an `AND` of "my team owns it, or it is
 * shared with my team" and the permission requirement. Any other shape is refused rather than
 * read as a match.
 */
function assertReachableShape(connection: unknown): void {
  const and = (connection as { AND?: Array<Record<string, unknown>> } | undefined)?.AND;
  const ownedOrShared = and?.[0] as { OR?: Array<Record<string, unknown>> } | undefined;
  const terms = ownedOrShared?.OR ?? [];
  const ok =
    Array.isArray(and) &&
    and.length === 2 &&
    terms.length === 2 &&
    'team' in (terms[0] ?? {}) &&
    'shares' in (terms[1] ?? {});
  if (!ok) {
    throw new Error(`unrecognised repository predicate: ${JSON.stringify(connection)}`);
  }
}

function pick(row: Record<string, unknown>, select: Record<string, unknown> | undefined) {
  if (!select) {
    return { ...row };
  }
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, v]) => v)
      .map(([k]) => [k, row[k]])
  );
}

describe('campaign routes', () => {
  const app = Fastify();

  // Mutable per-test state
  let currentRole = 'LEAD';
  let currentSub = 'user-1';
  /** teamId → userId → team role. */
  let teamRoles: Record<string, Record<string, string>> = {};
  let templateFound = true;
  let startFailure: Error | null = null;
  let signalFailure: Error | null = null;
  const connectionSelects: Array<Record<string, unknown>> = [];
  let campaigns: CampaignRow[] = [];
  let targets: TargetRow[] = [];
  let runInputs: Array<Record<string, unknown>> = [];
  let activeWorkflows: Array<Record<string, unknown>> = [];
  let audits: Array<Record<string, unknown>> = [];
  let liveStatuses: Record<string, string> = {};
  const started: Array<{ id: string; input: Record<string, unknown> }> = [];
  const signalled: string[] = [];

  const isMember = (teamId: string, sub = currentSub) => teamRoles[teamId]?.[sub] !== undefined;

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    app.decorate('auth', {
      verifyAccessToken: (token: string) => {
        if (!token) {
          throw new Error('No token');
        }
        return { exp: 9999999999, iat: 0, role: currentRole, sub: currentSub };
      },
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
          memberships: isMember(repo.teamId)
            ? [{ role: teamRoles[repo.teamId]?.[currentSub], userId: currentSub }]
            : [],
          monthlyBudgetUsdCents: null,
          name: team.name,
          organization: { id: team.orgId, isActive: true, monthlyBudgetUsdCents: null },
          orgId: team.orgId,
        },
        teamId: repo.teamId,
        type: 'git_repo',
      };
    };

    const matchesCampaign = (c: CampaignRow, where: Where): boolean => {
      const { id, ownerTeamId, state, OR, ...rest } = where as {
        id?: string;
        ownerTeamId?: string;
        state?: string;
        OR?: Array<Record<string, unknown>>;
      };
      if (Object.keys(rest).length > 0) {
        throw new Error(`unrecognised Campaign where: ${JSON.stringify(rest)}`);
      }
      if ((id && c.id !== id) || (ownerTeamId && c.ownerTeamId !== ownerTeamId)) {
        return false;
      }
      if (state && c.state !== state) {
        return false;
      }
      if (!OR) {
        return true;
      }
      return OR.some((term) => {
        if ('ownerTeam' in term) {
          const some = (term.ownerTeam as { memberships: { some: { userId: string } } }).memberships
            .some;
          return isMember(c.ownerTeamId, some.userId);
        }
        if ('targets' in term) {
          const connection = (term.targets as { some: { connection: unknown } }).some.connection;
          assertReachableShape(connection);
          return targets.some(
            (t) =>
              t.campaignId === c.id && t.connectionId !== null && isMember(t.teamId, currentSub)
          );
        }
        throw new Error(`unrecognised OR term: ${JSON.stringify(term)}`);
      });
    };

    const withRelations = (c: CampaignRow) => ({
      ...c,
      createdBy: c.createdById ? { id: c.createdById, name: 'Lead' } : null,
      ownerTeam: { id: c.ownerTeamId, name: TEAMS[c.ownerTeamId]?.name },
    });

    const prismaMock = {
      $executeRaw: async () => 1,
      // Truthy, so the launch's source snapshot locks succeed and the sources are recorded.
      $queryRaw: async () => [{ id: 'locked' }],
      $transaction: async (arg: unknown) => {
        if (typeof arg === 'function') {
          return arg(prismaMock);
        }
        return Promise.all(arg as Promise<unknown>[]);
      },
      activeWorkflow: {
        create: async (args: { data: Record<string, unknown> }) => {
          activeWorkflows.push(args.data);
          return { id: `aw-${activeWorkflows.length}`, ...args.data };
        },
        delete: async () => {
          activeWorkflows = [];
        },
        findMany: async (args: { where: { temporalWorkflowId: { in: string[] } } }) =>
          args.where.temporalWorkflowId.in.flatMap((id) =>
            liveStatuses[id] ? [{ currentStatus: liveStatuses[id], temporalWorkflowId: id }] : []
          ),
      },
      campaign: {
        count: async (args: { where: Where }) =>
          campaigns.filter((c) => matchesCampaign(c, args.where)).length,
        create: async (args: { data: Record<string, unknown> }) => {
          campaigns.push({
            cancelledAt: null,
            cancelledById: null,
            completedAt: null,
            createdAt: new Date(),
            recipeParams: null,
            recipeRef: null,
            updatedAt: new Date(),
            ...args.data,
          } as CampaignRow);
          return args.data;
        },
        findFirst: async (args: { where: Where; select?: Record<string, unknown> }) => {
          const row = campaigns.find((c) => matchesCampaign(c, args.where));
          return row ? pick(withRelations(row), args.select) : null;
        },
        findMany: async (args: {
          where: Where;
          skip?: number;
          take?: number;
          select?: Record<string, unknown>;
        }) =>
          campaigns
            .filter((c) => matchesCampaign(c, args.where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 1000))
            .map((c) => pick(withRelations(c), args.select)),
        updateMany: async (args: {
          where: { id: string; ownerTeamId: string; state: { notIn: string[] } };
          data: Partial<CampaignRow>;
        }) => {
          const rows = campaigns.filter(
            (c) =>
              c.id === args.where.id &&
              c.ownerTeamId === args.where.ownerTeamId &&
              !args.where.state.notIn.includes(c.state)
          );
          for (const row of rows) {
            Object.assign(row, args.data);
          }
          return { count: rows.length };
        },
      },
      campaignTarget: {
        createMany: async (args: { data: Array<Record<string, unknown>> }) => {
          for (const d of args.data) {
            targets.push({
              childWorkflowId: null,
              failureReason: null,
              finishedAt: null,
              id: `t-${targets.length + 1}`,
              path: null,
              prNumber: null,
              prUrl: null,
              startedAt: null,
              state: 'PENDING',
              verification: null,
              ...d,
            } as TargetRow);
          }
          return { count: args.data.length };
        },
        findMany: async (args: {
          where: { campaignId: string; connection?: unknown };
          select?: Record<string, unknown>;
        }) => {
          if (args.where.connection) {
            assertReachableShape(args.where.connection);
          }
          return targets
            .filter((t) => t.campaignId === args.where.campaignId)
            .filter(
              (t) =>
                !args.where.connection ||
                (t.connectionId !== null && isMember(t.teamId, currentSub))
            )
            .sort((a, b) => a.position - b.position)
            .map((t) => pick(t as unknown as Record<string, unknown>, args.select));
        },
        groupBy: async (args: { where: { campaignId: { in: string[] } } }) => {
          const out = new Map<string, { campaignId: string; state: string; n: number }>();
          for (const t of targets.filter((x) => args.where.campaignId.in.includes(x.campaignId))) {
            const key = `${t.campaignId}:${t.state}`;
            const row = out.get(key) ?? { campaignId: t.campaignId, n: 0, state: t.state };
            row.n += 1;
            out.set(key, row);
          }
          return [...out.values()].map((r) => ({
            _count: { _all: r.n },
            campaignId: r.campaignId,
            state: r.state,
          }));
        },
      },
      configAuditLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          audits.push(args.data);
          return args.data;
        },
      },
      connection: {
        findMany: async (args: {
          select?: Record<string, unknown>;
          where: { id: { in: string[] } };
        }) => {
          connectionSelects.push(args.select ?? {});
          return args.where.id.in.flatMap((id) => {
            const detail = repoDetail(id);
            return detail ? [detail] : [];
          });
        },
        findUnique: async (args: { where: { id: string } }) => repoDetail(args.where.id),
      },
      organizationMembership: {
        findUnique: async (args: {
          where: { userId_orgId: { orgId: string; userId: string } };
        }) => ({
          ...args.where.userId_orgId,
        }),
      },
      orgMonthlyUsage: { findUnique: async () => null },
      runInput: {
        create: async (args: { data: Record<string, unknown> }) => {
          runInputs.push(args.data);
          return args.data;
        },
        delete: async (args: { where: { id: string } }) => {
          runInputs = runInputs.filter((r) => r.id !== args.where.id);
          // Campaign.workRequest is onDelete: Cascade, and targets cascade from the campaign.
          const gone = campaigns.filter((c) => c.workRequestId === args.where.id).map((c) => c.id);
          campaigns = campaigns.filter((c) => !gone.includes(c.id));
          targets = targets.filter((t) => !gone.includes(t.campaignId));
        },
      },
      team: {
        findUnique: async (args: { where: { id: string } }) => {
          const team = TEAMS[args.where.id];
          if (!team) {
            return null;
          }
          const role = teamRoles[args.where.id]?.[currentSub];
          return {
            id: args.where.id,
            isActive: true,
            memberships: role ? [{ role }] : [],
            name: team.name,
            orgId: team.orgId,
          };
        },
      },
      teamMembership: {
        findUnique: async (args: {
          where: { userId_teamId: { teamId: string; userId: string } };
        }) => {
          const { teamId, userId } = args.where.userId_teamId;
          const role = teamRoles[teamId]?.[userId];
          return role ? { role } : null;
        },
      },
      user: {
        findUnique: async () => ({ id: currentSub, isActive: true, role: currentRole }),
      },
      workflowTemplate: {
        findFirst: async () => (templateFound ? TEMPLATE : null),
      },
    };

    app.decorate('prisma', prismaMock as unknown as never);
    app.decorate('temporal', {
      signalCampaignCancel: async (id: string) => {
        if (signalFailure) {
          throw signalFailure;
        }
        signalled.push(id);
      },
      startCampaignWorkflow: async (id: string, input: Record<string, unknown>) => {
        if (startFailure) {
          throw startFailure;
        }
        started.push({ id, input });
      },
    } as unknown as never);

    await app.register(campaignRoutes, { prefix: '/api/v1/campaigns' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    currentRole = 'LEAD';
    currentSub = 'user-1';
    // user-1 leads teams 1 and 2 (both org-1); nobody belongs to team 3.
    teamRoles = { [TEAM_1]: { 'user-1': 'LEAD' }, [TEAM_2]: { 'user-1': 'LEAD' }, [TEAM_3]: {} };
    templateFound = true;
    startFailure = null;
    signalFailure = null;
    campaigns = [];
    targets = [];
    runInputs = [];
    activeWorkflows = [];
    audits = [];
    liveStatuses = {};
    started.length = 0;
    signalled.length = 0;
    settings.disabledTeams = new Set();
    settings.maxParallel = 3;
    settings.maxTargets = 25;
  });

  const auth = { authorization: 'Bearer test-token' };
  const post = (payload: unknown, url = '/api/v1/campaigns') =>
    app.inject({ headers: auth, method: 'POST', payload: payload as object, url });
  const body = (res: { payload: string }) => JSON.parse(res.payload);

  const npmRecipe = {
    params: { packageName: 'lodash', targetVersion: '4.17.21' },
    ref: 'npm-dependency@1',
  };
  const valid = {
    description: 'Raise lodash to the patched release',
    name: 'lodash 4.17.21',
    ownerTeamId: TEAM_1,
    recipe: npmRecipe,
    repoIds: [REPO_A, REPO_B],
  };
  const expectNothingWritten = () => {
    expect(campaigns).toHaveLength(0);
    expect(targets).toHaveLength(0);
    expect(runInputs).toHaveLength(0);
    expect(started).toHaveLength(0);
    expect(audits).toHaveLength(0);
  };

  // ── POST / ──

  describe('POST /api/v1/campaigns — refusals', () => {
    it('requires authentication', async () => {
      const res = await app.inject({ method: 'POST', payload: valid, url: '/api/v1/campaigns' });
      expect(res.statusCode).toBe(401);
    });

    it('refuses an ENGINEER', async () => {
      currentRole = 'ENGINEER';
      const res = await post(valid);
      expect(res.statusCode).toBe(403);
      expectNothingWritten();
    });

    it('refuses a platform LEAD who is only an ENGINEER on the owning team', async () => {
      teamRoles[TEAM_1] = { 'user-1': 'ENGINEER' };
      const res = await post(valid);
      expect(res.statusCode).toBe(403);
      expect(body(res).error.code).toBe('FORBIDDEN');
      expectNothingWritten();
    });

    it('answers 404 for an owner team that does not exist', async () => {
      const res = await post({ ...valid, ownerTeamId: MISSING });
      expect(res.statusCode).toBe(404);
      expect(body(res).error.code).toBe('TEAM_NOT_FOUND');
    });

    it('refuses a LEAD of the owning team who does not lead a target repository’s team', async () => {
      teamRoles[TEAM_2] = { 'user-1': 'ENGINEER' };
      const res = await post(valid);
      expect(res.statusCode).toBe(403);
      const { error } = body(res);
      expect(error.code).toBe('FORBIDDEN');
      expect(error.reasons).toEqual([{ reason: 'team-lead-required', repo: 'org/beta' }]);
      expectNothingWritten();
    });

    it('refuses a repository in another organization without naming it', async () => {
      const res = await post({ ...valid, repoIds: [REPO_A, REPO_X] });
      expect(res.statusCode).toBe(400);
      expect(body(res).error.code).toBe('CAMPAIGN_CROSS_ORG');
      expect(JSON.stringify(body(res))).not.toContain('gamma');
      expectNothingWritten();
    });

    it('refuses when the setting is off for the owning team', async () => {
      settings.disabledTeams = new Set([TEAM_1]);
      const res = await post(valid);
      expect(res.statusCode).toBe(403);
      expect(body(res).error.code).toBe('CAMPAIGNS_DISABLED');
      expect(body(res).error.message).toContain('alpha-team');
      expectNothingWritten();
    });

    it('refuses when the setting is off for ANY target’s team, naming a repository the caller is in', async () => {
      settings.disabledTeams = new Set([TEAM_2]);
      const res = await post(valid);
      expect(res.statusCode).toBe(403);
      expect(body(res).error.code).toBe('CAMPAIGNS_DISABLED');
      expect(body(res).error.message).toContain('org/beta');
      expect(body(res).error.message).not.toContain('org/alpha');
      expectNothingWritten();
    });

    it('counts, rather than names, a disabled repository of a team the caller is outside', async () => {
      removeFromTeam(TEAM_2);
      settings.disabledTeams = new Set([TEAM_2]);
      const res = await post(valid);
      expect(res.statusCode).toBe(403);
      expect(body(res).error.code).toBe('CAMPAIGNS_DISABLED');
      expect(body(res).error.message).not.toContain('beta');
      expect(body(res).error.message).toContain('1 other repository');
    });

    it('refuses more repositories than the owning team’s limit', async () => {
      settings.maxTargets = 1;
      const res = await post(valid);
      expect(res.statusCode).toBe(400);
      expect(body(res).error.code).toBe('CAMPAIGN_TOO_MANY_TARGETS');
      expectNothingWritten();
    });

    it('answers 400 CAMPAIGN_RECIPE_INVALID for an unknown recipe', async () => {
      const res = await post({ ...valid, recipe: { ...npmRecipe, ref: 'cargo-dependency@1' } });
      expect(res.statusCode).toBe(400);
      expect(body(res).error.code).toBe('CAMPAIGN_RECIPE_INVALID');
    });

    it.each([
      ['a git specifier', { packageName: 'github:evil/repo', targetVersion: '1.0.0' }],
      ['a command substitution', { packageName: '$(touch pwned)', targetVersion: '1.0.0' }],
      ['an option', { packageName: '--registry=http://evil.test', targetVersion: '1.0.0' }],
      ['a semver range', { packageName: 'lodash', targetVersion: '^4.17.0' }],
      ['a shell separator in the version', { packageName: 'lodash', targetVersion: '1.0.0; id' }],
      ['a missing version', { packageName: 'lodash' }],
      ['an unknown parameter', { packageName: 'lodash', registry: 'x', targetVersion: '1.0.0' }],
    ])('refuses hostile parameters: %s', async (_label, params) => {
      const res = await post({ ...valid, recipe: { ...npmRecipe, params } });
      expect(res.statusCode).toBe(400);
      expect(body(res).error.code).toBe('CAMPAIGN_RECIPE_INVALID');
      expectNothingWritten();
    });

    it('refuses a Go module with an npm-style version', async () => {
      const res = await post({
        ...valid,
        recipe: {
          params: { packageName: 'github.com/gorilla/mux', targetVersion: '1.8.0' },
          ref: 'go-module@1',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(body(res).error.code).toBe('CAMPAIGN_RECIPE_INVALID');
    });

    it('answers 404 REPOS_NOT_FOUND for a repository that does not exist', async () => {
      const res = await post({ ...valid, repoIds: [REPO_A, MISSING] });
      expect(res.statusCode).toBe(404);
      expect(body(res).error.code).toBe('REPOS_NOT_FOUND');
      expectNothingWritten();
    });

    it('answers 503 when the built-in template is missing', async () => {
      templateFound = false;
      const res = await post(valid);
      expect(res.statusCode).toBe(503);
      expect(body(res).error.code).toBe('CAMPAIGN_TEMPLATE_MISSING');
      expectNothingWritten();
    });

    it('refuses a repository the caller cannot reach', async () => {
      removeFromTeam(TEAM_2);
      const res = await post(valid);
      expect(res.statusCode).toBe(403);
      expect(body(res).error.message).toContain('org/beta');
      expectNothingWritten();
    });

    it('reads each repository’s SCM provider for the launch decision', async () => {
      // The launch decision refuses a repository served by a provider it cannot ask, so the
      // provider must be selected; a select that omits it would read as GitHub.
      connectionSelects.length = 0;
      await post(valid);
      expect(connectionSelects.length).toBeGreaterThan(0);
      expect(connectionSelects[0]).toMatchObject({ scmProvider: true });
    });

    it('bounds the brief and refuses control characters in it and in the name', async () => {
      // Every child's start event carries the brief, so it has its own, lower bound.
      expect((await post({ ...valid, description: 'x'.repeat(8_001) })).statusCode).toBe(400);
      expect((await post({ ...valid, description: 'a\u0001b' })).statusCode).toBe(400);
      expect((await post({ ...valid, description: 'a\ud800b' })).statusCode).toBe(400);
      expect((await post({ ...valid, name: 'a\u001bb' })).statusCode).toBe(400);
      expectNothingWritten();
      const ok = await post({ ...valid, description: `${'x'.repeat(7_990)}\n\tdone` });
      expect(ok.statusCode).toBe(201);
    });

    it('rejects duplicate repository ids and an empty list as invalid input', async () => {
      expect((await post({ ...valid, repoIds: [REPO_A, REPO_A] })).statusCode).toBe(400);
      expect((await post({ ...valid, repoIds: [] })).statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/campaigns — launch', () => {
    it('writes the campaign, its ordered targets and the ledger, then starts the workflow', async () => {
      // REPO_B first: target order follows the request, not the database.
      const res = await post({ ...valid, maxParallel: 10, repoIds: [REPO_B, REPO_A] });
      expect(res.statusCode).toBe(201);
      const { data } = body(res);
      expect(data.targetCount).toBe(2);
      expect(data.temporalWorkflowId).toBe(`campaign-${data.campaignId}`);
      expect(data.detailPath).toBe(`/campaigns/${data.campaignId}`);

      expect(campaigns).toHaveLength(1);
      expect(campaigns[0]).toMatchObject({
        createdById: 'user-1',
        id: data.campaignId,
        maxParallel: 3, // min(10 asked, 3 allowed)
        name: 'lodash 4.17.21',
        orgId: 'org-1',
        ownerTeamId: TEAM_1,
        recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
        recipeRef: 'npm-dependency@1',
        state: 'STARTING',
        templateId: 'tpl-campaign',
        templateVersion: 3,
        temporalWorkflowId: data.temporalWorkflowId,
        workRequestId: data.workRequestId,
      });
      expect(targets.map((t) => [t.position, t.connectionId, t.teamId, t.repoLabel])).toEqual([
        [0, REPO_B, TEAM_2, 'org/beta'],
        [1, REPO_A, TEAM_1, 'org/alpha'],
      ]);

      // The ledger: cross-repo but pinned to the template, so it stays out of the epics list.
      expect(runInputs).toHaveLength(1);
      const runInput = runInputs[0] as Record<string, unknown>;
      expect(runInput).toMatchObject({
        id: data.workRequestId,
        isCrossRepo: true,
        requestedById: 'user-1',
        templateId: 'tpl-campaign',
        templateVersion: 3,
        ticketIsSynthetic: true,
      });
      expect(runInput.externalTicketId).toMatch(/^CAMPAIGN-[0-9a-f]{12}$/);
      expect(JSON.parse(runInput.requestPayload as string).label).toBe('lodash 4.17.21');
      expect(
        (runInput.knowledgeRepoSources as Array<{ repoId: string }>).map((s) => s.repoId)
      ).toEqual([REPO_A, REPO_B].sort());
      expect(activeWorkflows[0]).toMatchObject({
        budgetTier: 'STANDARD',
        repoId: null,
        temporalWorkflowId: data.temporalWorkflowId,
        workRequestId: data.workRequestId,
      });
    });

    it('freezes everything the workflow needs into its input', async () => {
      const res = await post({
        ...valid,
        budget: 'LARGE',
        maxParallel: 2,
        repoIds: [REPO_B, REPO_A],
      });
      expect(res.statusCode).toBe(201);
      const { data } = body(res);
      expect(started).toHaveLength(1);
      const call = started[0] as { id: string; input: Record<string, unknown> };
      expect(call.id).toBe(data.temporalWorkflowId);
      expect(call.input).toMatchObject({
        campaignId: data.campaignId,
        campaignWorkflowId: data.temporalWorkflowId,
        childPayload: {
          budget: 'LARGE',
          packageName: 'lodash',
          recipe: 'npm-dependency@1',
          targetVersion: '4.17.21',
        },
        description: valid.description,
        launchedById: 'user-1',
        maxParallel: 2,
        templateId: 'tpl-campaign',
        templateVersion: 3,
        workRequestId: data.workRequestId,
      });
      // The launch request is stored once, on the RunInput row, not carried into the workflow.
      expect(call.input).not.toHaveProperty('requestPayload');
      expect(call.input.targets).toEqual([
        { connectionId: REPO_B, repoLabel: 'org/beta', teamId: TEAM_2 },
        { connectionId: REPO_A, repoLabel: 'org/alpha', teamId: TEAM_1 },
      ]);
      expect(activeWorkflows[0]).toMatchObject({ budgetTier: 'LARGE' });
    });

    it('clamps maxParallel to the ceiling and defaults to it', async () => {
      settings.maxParallel = 2;
      await post(valid);
      expect(campaigns[0]?.maxParallel).toBe(2);
      expect(started[0]?.input.maxParallel).toBe(2);
    });

    it('writes one Campaign CREATE audit row beside the launch’s own', async () => {
      const res = await post(valid);
      const { data } = body(res);
      const row = audits.find((a) => a.entityType === 'Campaign');
      expect(row).toMatchObject({
        action: 'CREATE',
        actorId: 'user-1',
        afterJson: {
          maxParallel: 3,
          name: 'lodash 4.17.21',
          ownerTeamId: TEAM_1,
          recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
          recipeRef: 'npm-dependency@1',
          targetCount: 2,
          templateId: 'tpl-campaign',
          templateVersion: 3,
        },
        entityId: data.campaignId,
      });
      expect(audits.filter((a) => a.entityType === 'Campaign')).toHaveLength(1);
      expect(audits.find((a) => a.entityType === 'WorkRequest')).toMatchObject({
        afterJson: expect.objectContaining({ source: 'campaign' }),
      });
    });

    it('launches an agent-only campaign (no recipe) with no recipe in the payload', async () => {
      const { recipe: _recipe, ...agentOnly } = valid;
      const res = await post(agentOnly);
      expect(res.statusCode).toBe(201);
      expect(campaigns[0]?.recipeRef).toBeNull();
      expect(campaigns[0]?.recipeParams).toBeNull();
      expect(started[0]?.input.childPayload).toEqual({});
    });

    it('lets a platform ADMIN launch without any team membership', async () => {
      currentRole = 'ADMIN';
      teamRoles = {};
      const res = await post(valid);
      expect(res.statusCode).toBe(201);
    });

    it('compensates when the workflow fails to start: no campaign, targets or ledger remain', async () => {
      startFailure = new Error('temporal unreachable');
      const res = await post(valid);
      expect(res.statusCode).toBe(500);
      expect(campaigns).toHaveLength(0);
      expect(targets).toHaveLength(0);
      expect(runInputs).toHaveLength(0);
      expect(audits.filter((a) => a.entityType === 'Campaign')).toHaveLength(0);
    });

    it('answers 409 when Temporal already has the workflow', async () => {
      startFailure = Object.assign(new Error('started'), {
        name: 'WorkflowExecutionAlreadyStartedError',
      });
      const res = await post(valid);
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('CAMPAIGN_ALREADY_EXISTS');
      expect(campaigns).toHaveLength(0);
    });

    it('records a campaign in the ledger shape the epics list excludes', async () => {
      await post(valid);
      // GET /epics selects `isCrossRepo: true, templateId: null`; a pinned template is non-null.
      const runInput = runInputs[0] as { isCrossRepo: boolean; templateId: string | null };
      expect(runInput.isCrossRepo).toBe(true);
      expect(runInput.templateId).not.toBeNull();
    });
  });

  // ── Visibility ──

  /** Four campaigns: C1 owned by team 1 over repos A and B, C2 owned by team 2 over B, C3 owned
   *  by team 3 over X, C4 owned by team 1 over B alone. */
  function seed() {
    const base = (id: string, ownerTeamId: string, minute: number): CampaignRow => ({
      cancelledAt: null,
      cancelledById: null,
      completedAt: null,
      createdAt: new Date(`2026-06-01T00:${String(minute).padStart(2, '0')}:00Z`),
      createdById: 'creator-1',
      description: 'brief',
      id,
      maxParallel: 3,
      name: `campaign ${id}`,
      orgId: TEAMS[ownerTeamId]?.orgId as string,
      ownerTeamId,
      recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
      recipeRef: 'npm-dependency@1',
      state: 'RUNNING',
      templateId: 'tpl-campaign',
      templateVersion: 3,
      temporalWorkflowId: `campaign-${id}`,
      updatedAt: new Date(),
      workRequestId: `wr-${id}`,
    });
    const target = (
      campaignId: string,
      repo: string,
      position: number,
      state = 'PENDING'
    ): TargetRow => ({
      campaignId,
      childWorkflowId: state === 'RUNNING' ? `campaign-${campaignId}-${repo}` : null,
      connectionId: repo,
      failureReason: null,
      finishedAt: null,
      id: `t-${campaignId}-${position}`,
      path: null,
      position,
      prNumber: null,
      prUrl: null,
      repoLabel: `org/${REPOS[repo]?.repoName}`,
      startedAt: null,
      state,
      teamId: REPOS[repo]?.teamId as string,
      verification: null,
    });
    campaigns = [
      base('c1', TEAM_1, 1),
      base('c2', TEAM_2, 2),
      base('c3', TEAM_3, 3),
      base('c4', TEAM_1, 4),
    ];
    targets = [
      target('c1', REPO_A, 0, 'RUNNING'),
      target('c1', REPO_B, 1, 'PR_OPENED'),
      target('c2', REPO_B, 0),
      target('c3', REPO_X, 0),
      target('c4', REPO_B, 0),
    ];
  }

  /** Take user-1 out of a team altogether. */
  const removeFromTeam = (teamId: string) => {
    teamRoles[teamId] = {};
  };

  const as = (sub: string, role: string, teams: Record<string, string>) => {
    currentSub = sub;
    currentRole = role;
    teamRoles = {
      [TEAM_1]: {},
      [TEAM_2]: {},
      [TEAM_3]: {},
    };
    for (const [teamId, teamRole] of Object.entries(teams)) {
      (teamRoles[teamId] as Record<string, string>)[sub] = teamRole;
    }
  };

  describe('GET /api/v1/campaigns', () => {
    const list = async (query = '') =>
      app.inject({ headers: auth, method: 'GET', url: `/api/v1/campaigns${query}` });
    const ids = (res: { payload: string }) => body(res).data.map((c: { id: string }) => c.id);

    it('shows a team-1-only member the campaigns team 1 owns or reaches, newest first', async () => {
      seed();
      as('u-1', 'ENGINEER', { [TEAM_1]: 'ENGINEER' });
      const res = await list();
      expect(res.statusCode).toBe(200);
      // c1 and c4 are owned by team 1; c2 targets only team 2's repository; c3 is foreign.
      expect(ids(res)).toEqual(['c4', 'c1']);
      expect(body(res).meta.total).toBe(2);
    });

    it('shows a campaign to someone who reaches only one of its targets', async () => {
      seed();
      as('u-2', 'ENGINEER', { [TEAM_2]: 'ENGINEER' });
      // c1 (target B), c2 (owner), c4 (target B); not c3.
      expect(ids(await list())).toEqual(['c4', 'c2', 'c1']);
    });

    it('counts every target, including ones the viewer cannot reach, as numbers only', async () => {
      seed();
      as('u-1', 'ENGINEER', { [TEAM_1]: 'ENGINEER' });
      const res = await list();
      const c1 = body(res).data.find((c: { id: string }) => c.id === 'c1');
      expect(c1.counts).toEqual({
        CANCELLED: 0,
        FAILED: 0,
        NOT_AFFECTED: 0,
        PENDING: 0,
        PR_OPENED: 1,
        RUNNING: 1,
        SKIPPED: 0,
      });
      expect(c1).not.toHaveProperty('targets');
      expect(c1.ownerTeam).toEqual({ id: TEAM_1, name: 'alpha-team' });
    });

    it('shows an ADMIN every campaign', async () => {
      seed();
      as('admin-1', 'ADMIN', {});
      const res = await list();
      expect(ids(res)).toEqual(['c4', 'c3', 'c2', 'c1']);
      expect(body(res).meta.total).toBe(4);
    });

    it('shows an unrelated user nothing', async () => {
      seed();
      as('stranger', 'ENGINEER', {});
      const res = await list();
      expect(ids(res)).toEqual([]);
      expect(body(res).meta.total).toBe(0);
    });

    it('filters by owning team and state, and pages', async () => {
      seed();
      as('admin-1', 'ADMIN', {});
      expect(ids(await list(`?ownerTeamId=${TEAM_2}`))).toEqual(['c2']);
      (campaigns.find((c) => c.id === 'c3') as CampaignRow).state = 'COMPLETED';
      expect(ids(await list('?state=COMPLETED'))).toEqual(['c3']);
      const page = await list('?limit=1&offset=1');
      expect(ids(page)).toEqual(['c3']);
      expect(body(page).meta).toEqual({ limit: 1, offset: 1, total: 4 });
    });

    it('requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/campaigns' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/campaigns/:id', () => {
    const detail = (id: string) =>
      app.inject({ headers: auth, method: 'GET', url: `/api/v1/campaigns/${id}` });

    // Detail ids must be UUIDs; remap the seeded ids.
    const U = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;
    function seedUuids() {
      seed();
      const map: Record<string, string> = { c1: U(1), c2: U(2), c3: U(3), c4: U(4) };
      for (const c of campaigns) {
        const old = c.id;
        c.id = map[old] as string;
        c.temporalWorkflowId = `campaign-${c.id}`;
      }
      for (const t of targets) {
        t.campaignId = map[t.campaignId] as string;
        if (t.childWorkflowId) {
          t.childWorkflowId = `campaign-${t.campaignId}-${t.connectionId}`;
        }
      }
    }

    it('shows an owner-team member the counts but not a target they cannot reach', async () => {
      seedUuids();
      as('u-1', 'ENGINEER', { [TEAM_1]: 'ENGINEER' });
      const res = await detail(U(1));
      expect(res.statusCode).toBe(200);
      const { data } = body(res);
      expect(data.targets.map((t: { repoLabel: string }) => t.repoLabel)).toEqual(['org/alpha']);
      expect(data.hiddenTargetCount).toBe(1);
      expect(data.counts.PR_OPENED).toBe(1);
      expect(data.counts.RUNNING).toBe(1);
      // The hidden target’s identity, PR and reason never cross.
      expect(res.payload).not.toContain('org/beta');
      expect(res.payload).not.toContain(REPO_B);
    });

    it('shows an owner-team member who reaches no target an empty list and a hidden count', async () => {
      seedUuids();
      as('u-1', 'ENGINEER', { [TEAM_1]: 'ENGINEER' });
      const res = await detail(U(4));
      expect(res.statusCode).toBe(200);
      expect(body(res).data.targets).toEqual([]);
      expect(body(res).data.hiddenTargetCount).toBe(1);
      expect(body(res).data.counts.PENDING).toBe(1);
    });

    it('takes liveStatus from the child’s ledger row for a RUNNING target only', async () => {
      seedUuids();
      liveStatuses[`campaign-${U(1)}-${REPO_A}`] = 'IMPLEMENTING';
      as('u-1', 'LEAD', { [TEAM_1]: 'LEAD', [TEAM_2]: 'LEAD' });
      const { data } = body(await detail(U(1)));
      const byLabel = Object.fromEntries(
        data.targets.map((t: { repoLabel: string }) => [t.repoLabel, t])
      );
      expect(byLabel['org/alpha'].liveStatus).toBe('IMPLEMENTING');
      expect(byLabel['org/beta'].liveStatus).toBeNull();
      expect(data.hiddenTargetCount).toBe(0);
    });

    it('shows an ADMIN every target', async () => {
      seedUuids();
      as('admin-1', 'ADMIN', {});
      const { data } = body(await detail(U(1)));
      expect(data.targets).toHaveLength(2);
      expect(data.hiddenTargetCount).toBe(0);
      expect(data.targets.map((t: { position: number }) => t.position)).toEqual([0, 1]);
    });

    it('answers 404, never 403, for a campaign the caller cannot see', async () => {
      seedUuids();
      as('stranger', 'ENGINEER', {});
      for (const id of [U(1), U(3)]) {
        const res = await detail(id);
        expect(res.statusCode).toBe(404);
        expect(body(res).error.code).toBe('CAMPAIGN_NOT_FOUND');
      }
      // A team-1 member cannot see a campaign wholly in another organization either.
      as('u-1', 'ENGINEER', { [TEAM_1]: 'ENGINEER' });
      expect((await detail(U(3))).statusCode).toBe(404);
    });

    it('answers 404 for an unknown id and 400 for a malformed one', async () => {
      seedUuids();
      as('admin-1', 'ADMIN', {});
      expect((await detail(MISSING)).statusCode).toBe(404);
      expect((await detail('not-a-uuid')).statusCode).toBe(400);
    });
  });

  // ── Cancel ──

  describe('POST /api/v1/campaigns/:id/cancel', () => {
    const U = (n: number) => `00000000-0000-4000-8000-00000000020${n}`;
    function seedActive(state = 'RUNNING') {
      seed();
      const c = campaigns[0] as CampaignRow;
      c.id = U(1);
      c.temporalWorkflowId = `campaign-${U(1)}`;
      c.state = state;
      for (const t of targets.filter((x) => x.campaignId === 'c1')) {
        t.campaignId = U(1);
      }
      campaigns = [c];
    }
    const cancel = (id = U(1)) =>
      app.inject({ headers: auth, method: 'POST', url: `/api/v1/campaigns/${id}/cancel` });

    it('lets the creator cancel: CANCELLING, a signal and an audit row, 202', async () => {
      seedActive();
      as('creator-1', 'ENGINEER', { [TEAM_1]: 'ENGINEER' });
      const res = await cancel();
      expect(res.statusCode).toBe(202);
      expect(body(res).data).toEqual({ campaignId: U(1), state: 'CANCELLING' });
      expect(campaigns[0]).toMatchObject({ cancelledById: 'creator-1', state: 'CANCELLING' });
      expect(campaigns[0]?.cancelledAt).toBeInstanceOf(Date);
      expect(signalled).toEqual([`campaign-${U(1)}`]);
      expect(audits).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          actorId: 'creator-1',
          afterJson: { cancelledById: 'creator-1', state: 'CANCELLING' },
          beforeJson: { state: 'RUNNING' },
          entityId: U(1),
          entityType: 'Campaign',
        }),
      ]);
    });

    it('lets a LEAD of the owning team cancel, and an ADMIN', async () => {
      seedActive();
      as('lead-1', 'LEAD', { [TEAM_1]: 'LEAD' });
      expect((await cancel()).statusCode).toBe(202);
      seedActive();
      as('admin-1', 'ADMIN', {});
      expect((await cancel()).statusCode).toBe(202);
    });

    it('refuses an owning-team ENGINEER who is not the creator', async () => {
      seedActive();
      as('u-1', 'ENGINEER', { [TEAM_1]: 'ENGINEER' });
      const res = await cancel();
      expect(res.statusCode).toBe(403);
      expect(signalled).toHaveLength(0);
      expect(campaigns[0]?.state).toBe('RUNNING');
    });

    it('refuses someone who only reaches a target, even as that team’s LEAD', async () => {
      seedActive();
      as('lead-2', 'LEAD', { [TEAM_2]: 'LEAD' });
      const res = await cancel();
      expect(res.statusCode).toBe(403);
      expect(signalled).toHaveLength(0);
    });

    it('answers 404 to someone who cannot see the campaign', async () => {
      seedActive();
      as('stranger', 'LEAD', {});
      const res = await cancel();
      expect(res.statusCode).toBe(404);
      expect(body(res).error.code).toBe('CAMPAIGN_NOT_FOUND');
      expect(signalled).toHaveLength(0);
    });

    it.each(['COMPLETED', 'COMPLETED_WITH_FAILURES', 'CANCELLED', 'FAILED_TO_START'])(
      'answers 409 CAMPAIGN_NOT_ACTIVE for a %s campaign',
      async (state) => {
        seedActive(state);
        as('admin-1', 'ADMIN', {});
        const res = await cancel();
        expect(res.statusCode).toBe(409);
        expect(body(res).error.code).toBe('CAMPAIGN_NOT_ACTIVE');
        expect(signalled).toHaveLength(0);
        expect(audits).toHaveLength(0);
        expect(campaigns[0]?.state).toBe(state);
      }
    );

    it('allows a second cancel of a CANCELLING campaign, so a lost signal can be re-sent', async () => {
      seedActive('CANCELLING');
      as('admin-1', 'ADMIN', {});
      expect((await cancel()).statusCode).toBe(202);
      expect(signalled).toHaveLength(1);
    });

    it('answers 503 when the signal cannot be delivered, leaving the campaign CANCELLING', async () => {
      seedActive();
      as('admin-1', 'ADMIN', {});
      signalFailure = new Error('unreachable');
      const res = await cancel();
      expect(res.statusCode).toBe(503);
      expect(body(res).error.code).toBe('CAMPAIGN_SIGNAL_FAILED');
      expect(campaigns[0]?.state).toBe('CANCELLING');
      expect(audits).toHaveLength(0);
    });
  });
});
