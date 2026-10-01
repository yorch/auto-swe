// Repository URL overrides (host lockdown + normalisation) and team sharing.
import { ConnectionTypeSchema } from '@auto-swe/shared/lib/connectionTypes';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_NULL = vi.hoisted(() => ({ __sentinel: 'Prisma.DbNull' }));
vi.mock('@auto-swe/shared', () => ({
  ConnectionTypeSchema,
  encryptConnectionApiToken: () => ({}),
  Prisma: { DbNull: DB_NULL },
  Role: { ADMIN: 'ADMIN', ENGINEER: 'ENGINEER', LEAD: 'LEAD' },
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));

const repositoryHostsAllowed = vi.fn();
vi.mock('@auto-swe/shared/lib/connectionCredential', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  repositoryHostsAllowed: (...a: unknown[]) => repositoryHostsAllowed(...a),
}));

const { repositoryRoutes } = await import('./repositories.js');

const TEAM = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM = '44444444-4444-4444-8444-444444444444';
const REPO = '33333333-3333-4333-8333-333333333333';
const ORG = '55555555-5555-4555-8555-555555555555';
const AUTH = { authorization: 'Bearer fake-jwt' };

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const auth = { role: 'ADMIN' as 'ADMIN' | 'LEAD', sub: 'user-1' };
  const prisma = {
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    connectionTeamShare: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    team: { findMany: vi.fn(), findUnique: vi.fn() },
    teamMembership: { findUnique: vi.fn() },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: auth.role, sub: auth.sub }),
  } as unknown as never);
  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.ready();
  return { app, auth, prisma };
}

describe('repository URL overrides', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.auth.role = 'ADMIN';
    repositoryHostsAllowed.mockResolvedValue({ ok: true });
    ctx.prisma.team.findUnique.mockResolvedValue({ id: TEAM, isActive: true });
    ctx.prisma.connection.findFirst.mockResolvedValue(null);
    ctx.prisma.connection.create.mockImplementation(async ({ data }) => ({ id: REPO, ...data }));
  });

  function onboard(urls: Record<string, string>) {
    return ctx.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { organizationName: 'acme', repoName: 'api', teamId: TEAM, ...urls },
      url: '/api/v1/repositories',
    });
  }

  it('stores a web base as its origin and the API base without a trailing slash', async () => {
    const res = await onboard({
      githubApiUrl: 'https://ghe.corp/api/v3/',
      githubUrl: 'https://GHE.corp/',
    });
    expect(res.statusCode).toBe(201);
    expect(ctx.prisma.connection.create.mock.calls[0][0].data).toMatchObject({
      githubApiUrl: 'https://ghe.corp/api/v3',
      githubUrl: 'https://ghe.corp',
    });
    // The duplicate check keys on the same normalised host the index does.
    expect(ctx.prisma.connection.findFirst.mock.calls[0][0].where).toMatchObject({
      githubUrl: 'https://ghe.corp',
    });
  });

  it('stores an override equal to the instance host as no override', async () => {
    const res = await onboard({
      githubApiUrl: 'https://api.github.com/',
      githubUrl: 'https://github.com',
    });
    expect(res.statusCode).toBe(201);
    expect(ctx.prisma.connection.create.mock.calls[0][0].data).toMatchObject({
      githubApiUrl: null,
      githubUrl: null,
    });
  });

  it("refuses a repository's own URLs where a base is expected", async () => {
    // What the import dialog used to store, breaking every clone.
    let res = await onboard({ githubUrl: 'https://github.com/acme/api' });
    expect(res.statusCode).toBe(400);
    res = await onboard({ githubApiUrl: 'https://api.github.com/repos/acme/api' });
    expect(res.statusCode).toBe(400);
    expect(ctx.prisma.connection.create).not.toHaveBeenCalled();
  });

  it('refuses an override on a host nobody approved, for an admin too', async () => {
    repositoryHostsAllowed.mockResolvedValue({ ok: false, url: 'https://collector.example' });
    const res = await onboard({ githubUrl: 'https://collector.example' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('REPO_HOST_NOT_ALLOWED');
    expect(ctx.prisma.connection.create).not.toHaveBeenCalled();
  });

  it('answers 403 before validating URLs for someone who cannot manage the team', async () => {
    ctx.auth.role = 'LEAD';
    ctx.prisma.teamMembership.findUnique.mockResolvedValue(null);
    const res = await onboard({ githubUrl: 'https://collector.example' });
    expect(res.statusCode).toBe(403);
    expect(repositoryHostsAllowed).not.toHaveBeenCalled();
  });
});

describe('repository sharing', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.auth.role = 'ADMIN';
    ctx.prisma.connection.findUnique.mockResolvedValue({
      id: REPO,
      shares: [],
      team: { orgId: ORG },
      teamId: TEAM,
      type: 'git_repo',
    });
    ctx.prisma.team.findMany.mockResolvedValue([{ id: OTHER_TEAM }]);
  });

  function share(teamIds: string[]) {
    return ctx.app.inject({
      headers: AUTH,
      method: 'PUT',
      payload: { teamIds },
      url: `/api/v1/repositories/${REPO}/shares`,
    });
  }

  it('shares only with active teams in the owning organization, and audits it', async () => {
    const res = await share([OTHER_TEAM]);
    expect(res.statusCode).toBe(200);
    expect(ctx.prisma.team.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [OTHER_TEAM] },
      isActive: true,
      orgId: ORG,
    });
    expect(ctx.prisma.connectionTeamShare.createMany).toHaveBeenCalledWith({
      data: [{ connectionId: REPO, createdById: 'user-1', teamId: OTHER_TEAM }],
      skipDuplicates: true,
    });
    expect(ctx.prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'UPDATE', entityId: REPO }),
    });
  });

  it('refuses a team in another organization, or one that does not exist', async () => {
    ctx.prisma.team.findMany.mockResolvedValue([]);
    const res = await share([OTHER_TEAM]);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_SHARE_TEAMS');
    expect(ctx.prisma.connectionTeamShare.createMany).not.toHaveBeenCalled();
  });

  it('never shares with the owning team itself', async () => {
    ctx.prisma.team.findMany.mockResolvedValue([]);
    expect((await share([TEAM])).statusCode).toBe(200);
    expect(ctx.prisma.connectionTeamShare.createMany.mock.calls[0][0].data).toEqual([]);
  });

  it("is managed by the owning team's leads only", async () => {
    // A lead of another team — say, one the repository is shared with.
    ctx.auth.role = 'LEAD';
    ctx.prisma.teamMembership.findUnique.mockResolvedValue(null);
    const res = await share([OTHER_TEAM]);
    expect(res.statusCode).toBe(403);
    expect(ctx.prisma.connectionTeamShare.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses to share a non-git connection', async () => {
    ctx.prisma.connection.findUnique.mockResolvedValue({
      id: REPO,
      shares: [],
      team: { orgId: ORG },
      teamId: TEAM,
      type: 'mcp',
    });
    expect((await share([OTHER_TEAM])).statusCode).toBe(404);
  });

  it('offers the owning organization’s other active teams as candidates', async () => {
    ctx.prisma.team.findMany.mockResolvedValue([{ id: OTHER_TEAM, name: 'Other', slug: 'other' }]);
    const res = await ctx.app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/repositories/${REPO}/share-candidates`,
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.prisma.team.findMany.mock.calls[0][0].where).toEqual({
      id: { not: TEAM },
      isActive: true,
      orgId: ORG,
    });
  });
});
