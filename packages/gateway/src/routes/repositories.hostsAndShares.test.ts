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

const listGitHubRepos = vi.fn();
vi.mock('../lib/github.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/github.js')>()),
  listGitHubRepos: (...a: unknown[]) => listGitHubRepos(...a),
}));

const { repositoryRoutes } = await import('./repositories.js');

const TEAM = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM = '44444444-4444-4444-8444-444444444444';
const REPO = '33333333-3333-4333-8333-333333333333';
const ORG = '55555555-5555-4555-8555-555555555555';
const INSTALLATION = '66666666-6666-4666-8666-666666666666';
const AUTH = { authorization: 'Bearer fake-jwt' };

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const auth = { role: 'ADMIN' as 'ADMIN' | 'LEAD', sub: 'user-1' };
  const prisma = {
    $transaction: vi.fn<(arg: unknown) => Promise<unknown>>((ops) =>
      Promise.all(ops as Promise<unknown>[])
    ),
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    connectionTeamShare: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    gitHubInstallation: { findUnique: vi.fn() },
    runInput: { findUnique: vi.fn() },
    scheduledWorkRequest: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    team: { findMany: vi.fn(), findUnique: vi.fn() },
    teamMembership: { findUnique: vi.fn() },
  };
  const temporal = { syncWorkRequestSchedule: vi.fn().mockResolvedValue(undefined) };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('temporal', temporal as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: auth.role, sub: auth.sub }),
  } as unknown as never);
  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.ready();
  return { app, auth, prisma, temporal };
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

  it('refuses a web base without an API base, and the reverse (400)', async () => {
    const cases: Array<Record<string, string>> = [
      { githubUrl: 'https://ghe.corp' },
      { githubApiUrl: 'https://ghe.corp/api/v3' },
      { githubApiUrl: 'https://ghe.corp/api/v3', githubUrl: 'https://other.corp' },
    ];
    for (const urls of cases) {
      const res = await onboard(urls);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('REPO_HOST_MISMATCH');
    }
    expect(ctx.prisma.connection.create).not.toHaveBeenCalled();
  });

  it('accepts a GitHub Enterprise Cloud pair as one host (acme.ghe.com with api.acme.ghe.com)', async () => {
    const res = await onboard({
      githubApiUrl: 'https://api.acme.ghe.com',
      githubUrl: 'https://acme.ghe.com',
    });
    expect(res.statusCode).toBe(201);
  });

  it('checks for a duplicate owner and name case-insensitively', async () => {
    const res = await ctx.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { organizationName: 'Acme', repoName: 'API', teamId: TEAM },
      url: '/api/v1/repositories',
    });
    expect(res.statusCode).toBe(201);
    expect(ctx.prisma.connection.findFirst.mock.calls[0][0].where).toMatchObject({
      organizationName: { equals: 'Acme', mode: 'insensitive' },
      repoName: { equals: 'API', mode: 'insensitive' },
    });
  });

  it('matches the owner and name literally: ILIKE wildcards are escaped', async () => {
    // Prisma compiles an insensitive `equals` to ILIKE without escaping, so an
    // unescaped `_` would let `my_repo` collide with `my-repo`. A mock cannot
    // see ILIKE, so the where must carry the escaped literal.
    const res = await ctx.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { organizationName: 'my_org', repoName: 'MY_REPO%', teamId: TEAM },
      url: '/api/v1/repositories',
    });
    expect(res.statusCode).toBe(201);
    expect(ctx.prisma.connection.findFirst.mock.calls[0][0].where).toMatchObject({
      organizationName: { equals: 'my\\_org', mode: 'insensitive' },
      repoName: { equals: 'MY\\_REPO\\%', mode: 'insensitive' },
    });
    // What is stored is the real name, not the escaped pattern.
    expect(ctx.prisma.connection.create.mock.calls[0][0].data).toMatchObject({
      organizationName: 'my_org',
      repoName: 'MY_REPO%',
    });
  });

  describe('repointing a repository onto another host (PATCH)', () => {
    beforeEach(() => {
      ctx.prisma.connection.findUnique.mockResolvedValue({
        id: REPO,
        organizationName: 'Acme',
        repoName: 'My_API',
        teamId: TEAM,
        type: 'git_repo',
      });
      ctx.prisma.connection.update.mockResolvedValue({ id: REPO });
    });

    const patch = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload,
        url: `/api/v1/repositories/${REPO}`,
      });

    it('refuses a host where the same owner/name exists, ignoring case (409)', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue({ id: 'other' });
      const res = await patch({
        githubApiUrl: 'https://ghe.corp/api/v3',
        githubUrl: 'https://ghe.corp',
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('REPO_EXISTS');
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
      expect(ctx.prisma.connection.findFirst.mock.calls[0][0].where).toMatchObject({
        githubUrl: 'https://ghe.corp',
        id: { not: REPO },
        organizationName: { equals: 'Acme', mode: 'insensitive' },
        repoName: { equals: 'My\\_API', mode: 'insensitive' },
        type: 'git_repo',
      });
    });

    it('allows a host where the repository is not onboarded', async () => {
      const res = await patch({
        githubApiUrl: 'https://ghe.corp/api/v3',
        githubUrl: 'https://ghe.corp',
      });
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.connection.update).toHaveBeenCalled();
    });

    it('refuses a web base alone: the API base would stay the instance’s', async () => {
      const res = await patch({ githubUrl: 'https://ghe.corp' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('REPO_HOST_MISMATCH');
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
    });

    it('judges a field this request does not set against the stored one', async () => {
      ctx.prisma.connection.findUnique.mockResolvedValue({
        githubApiUrl: 'https://ghe.corp/api/v3',
        githubUrl: 'https://ghe.corp',
        id: REPO,
        organizationName: 'Acme',
        repoName: 'My_API',
        teamId: TEAM,
        type: 'git_repo',
      });
      // Repoint the web base only: now the pair disagrees.
      const res = await patch({ githubUrl: 'https://other.corp' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('REPO_HOST_MISMATCH');
      // Clearing the web base alone leaves a foreign API base on the instance's web host.
      const cleared = await patch({ githubUrl: null });
      expect(cleared.statusCode).toBe(400);
      // Clearing both is back to the instance's own host.
      const both = await patch({ githubApiUrl: null, githubUrl: null });
      expect(both.statusCode).toBe(200);
    });

    it('does not look for a duplicate when the host is not being changed', async () => {
      const res = await patch({ description: 'x' });
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.connection.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("an installation must live on the repository's host", () => {
    const GHE = { githubApiUrl: 'https://ghe.corp/api/v3', githubUrl: 'https://ghe.corp' };
    const installation = (host: string) =>
      ctx.prisma.gitHubInstallation.findUnique.mockResolvedValue({
        host,
        installationId: '4242',
      });

    it("refuses the instance's installation for a repository on another host, and the reverse", async () => {
      installation('');
      const res = await onboard({ ...GHE, installationId: INSTALLATION });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('INSTALLATION_HOST_MISMATCH');
      expect(ctx.prisma.connection.create).not.toHaveBeenCalled();

      installation('ghe.corp');
      const onInstance = await onboard({ installationId: INSTALLATION });
      expect(onInstance.statusCode).toBe(400);
      expect(JSON.parse(onInstance.payload).error.code).toBe('INSTALLATION_HOST_MISMATCH');
    });

    it("refuses another host's installation, even one with the same numeric id", async () => {
      installation('ghe.other');
      const res = await onboard({ ...GHE, installationId: INSTALLATION });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.message).toContain('ghe.other');
    });

    it("accepts the host's own installation, and the instance's for an instance repository", async () => {
      installation('ghe.corp');
      expect((await onboard({ ...GHE, installationId: INSTALLATION })).statusCode).toBe(201);
      installation('');
      expect((await onboard({ installationId: INSTALLATION })).statusCode).toBe(201);
    });

    describe('when editing', () => {
      beforeEach(() => {
        ctx.prisma.connection.findUnique.mockResolvedValue({
          githubApiUrl: null,
          githubUrl: null,
          id: REPO,
          installationId: INSTALLATION,
          organizationName: 'Acme',
          repoName: 'My_API',
          teamId: TEAM,
          type: 'git_repo',
        });
        ctx.prisma.connection.update.mockResolvedValue({ id: REPO });
      });
      const patch = (payload: Record<string, unknown>) =>
        ctx.app.inject({
          headers: AUTH,
          method: 'PATCH',
          payload,
          url: `/api/v1/repositories/${REPO}`,
        });

      it("refuses repointing a repository away from its installation's host", async () => {
        installation('');
        const res = await patch(GHE);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error.code).toBe('INSTALLATION_HOST_MISMATCH');
        expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
      });

      it('allows repointing together with a matching installation, and stores it', async () => {
        installation('ghe.corp');
        const res = await patch({ ...GHE, installationId: INSTALLATION });
        expect(res.statusCode).toBe(200);
        expect(ctx.prisma.connection.update.mock.calls[0][0].data).toMatchObject({
          installationId: INSTALLATION,
        });
      });

      it('does not look at installations when neither side changes', async () => {
        const res = await patch({ description: 'x' });
        expect(res.statusCode).toBe(200);
        expect(ctx.prisma.gitHubInstallation.findUnique).not.toHaveBeenCalled();
      });

      it("lets an admin repoint a repository at the singleton's installation (null)", async () => {
        const res = await patch({ installationId: null });
        expect(res.statusCode).toBe(200);
        expect(ctx.prisma.connection.update.mock.calls[0][0].data).toMatchObject({
          installationId: null,
        });
      });
    });
  });

  it('refuses a repository that differs from an onboarded one only by case (409)', async () => {
    ctx.prisma.connection.findFirst.mockResolvedValue({ id: REPO });
    const res = await onboard({});
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error.code).toBe('REPO_EXISTS');
    expect(ctx.prisma.connection.create).not.toHaveBeenCalled();
  });

  it('marks a GitHub repo already imported whatever the stored casing', async () => {
    listGitHubRepos.mockResolvedValue([
      { name: 'api', org: 'acme' },
      { name: 'web', org: 'acme' },
    ]);
    ctx.prisma.connection.findMany.mockResolvedValue([
      { organizationName: 'Acme', repoName: 'API' },
    ]);
    const res = await ctx.app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/repositories/github/available',
    });
    expect(res.statusCode).toBe(200);
    expect(
      JSON.parse(res.payload).data.map((r: { alreadyImported: boolean }) => r.alreadyImported)
    ).toEqual([true, false]);
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
    ctx.prisma.scheduledWorkRequest.findMany.mockResolvedValue([]);
    ctx.prisma.scheduledWorkRequest.updateMany.mockResolvedValue({ count: 1 });
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

  describe('schedules of a team that loses its share', () => {
    const SCHEDULE = '66666666-6666-4666-8666-666666666666';
    const stranded = {
      actsAsUserId: 'author-1',
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'deps',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE,
      isActive: true,
      name: 'deps',
      repoId: REPO,
      teamId: OTHER_TEAM,
      workRequestId: 'wr-1',
    };

    beforeEach(() => {
      // The row as it stands after the conditional write: inactive.
      ctx.prisma.scheduledWorkRequest.findUnique.mockResolvedValue({
        ...stranded,
        isActive: false,
      });
    });

    it('pauses them in the database and in Temporal', async () => {
      // The repo, after the replacement, no longer lists OTHER_TEAM.
      ctx.prisma.scheduledWorkRequest.findMany.mockResolvedValue([stranded]);
      ctx.prisma.runInput.findUnique.mockResolvedValue({ templateId: 'tpl-1', templateVersion: 3 });
      ctx.prisma.team.findMany.mockResolvedValue([]);
      expect((await share([])).statusCode).toBe(200);
      // A schedule whose team was deleted (null) has no claim either.
      expect(ctx.prisma.scheduledWorkRequest.findMany.mock.calls[0][0].where).toEqual({
        isActive: true,
        OR: [{ teamId: null }, { teamId: { notIn: [TEAM] } }],
        repoId: REPO,
      });
      expect(ctx.prisma.scheduledWorkRequest.updateMany).toHaveBeenCalledWith({
        data: { isActive: false, version: { increment: 1 } },
        where: { id: SCHEDULE, isActive: true, teamId: OTHER_TEAM },
      });
      expect(ctx.temporal.syncWorkRequestSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ paused: true, scheduleRowId: SCHEDULE })
      );
    });

    it('keeps the database pause when Temporal cannot be reached', async () => {
      ctx.prisma.scheduledWorkRequest.findMany.mockResolvedValue([stranded]);
      ctx.prisma.runInput.findUnique.mockResolvedValue({ templateId: 'tpl-1', templateVersion: 3 });
      ctx.temporal.syncWorkRequestSchedule.mockRejectedValueOnce(new Error('down'));
      ctx.prisma.team.findMany.mockResolvedValue([]);
      expect((await share([])).statusCode).toBe(200);
      expect(ctx.prisma.scheduledWorkRequest.updateMany).toHaveBeenCalled();
    });

    it('keeps going past a row it cannot deactivate, and still audits the share change', async () => {
      const second = { ...stranded, id: '77777777-7777-4777-8777-777777777777' };
      ctx.prisma.scheduledWorkRequest.findMany.mockResolvedValue([stranded, second]);
      ctx.prisma.runInput.findUnique.mockResolvedValue({ templateId: 'tpl-1', templateVersion: 3 });
      ctx.prisma.scheduledWorkRequest.updateMany.mockRejectedValueOnce(new Error('db down'));
      ctx.prisma.team.findMany.mockResolvedValue([]);
      expect((await share([])).statusCode).toBe(200);
      expect(ctx.prisma.scheduledWorkRequest.updateMany).toHaveBeenCalledTimes(2);
      expect(ctx.prisma.configAuditLog.create).toHaveBeenCalled();
    });

    it('does not fail the request when looking for stranded schedules fails', async () => {
      ctx.prisma.scheduledWorkRequest.findMany.mockRejectedValue(new Error('db down'));
      ctx.prisma.team.findMany.mockResolvedValue([]);
      expect((await share([])).statusCode).toBe(200);
      expect(ctx.prisma.configAuditLog.create).toHaveBeenCalled();
    });

    it('records the audit row before deactivating', async () => {
      const order: string[] = [];
      ctx.prisma.configAuditLog.create.mockImplementationOnce(async () => {
        order.push('audit');
        return {};
      });
      ctx.prisma.scheduledWorkRequest.findMany.mockImplementationOnce(async () => {
        order.push('deactivate');
        return [];
      });
      ctx.prisma.team.findMany.mockResolvedValue([]);
      expect((await share([])).statusCode).toBe(200);
      expect(order).toEqual(['audit', 'deactivate']);
    });

    it('pauses the old owner team schedules when the repository moves', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue({ isActive: true, orgId: ORG });
      ctx.prisma.connection.update.mockResolvedValue({ id: REPO, team: { id: OTHER_TEAM } });
      ctx.prisma.$transaction.mockImplementationOnce(async (fn) =>
        (fn as (tx: typeof ctx.prisma) => Promise<unknown>)(ctx.prisma)
      );
      ctx.prisma.scheduledWorkRequest.findMany.mockResolvedValue([{ ...stranded, teamId: TEAM }]);
      ctx.prisma.runInput.findUnique.mockResolvedValue({ templateId: 'tpl-1', templateVersion: 3 });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { teamId: OTHER_TEAM },
        url: `/api/v1/repositories/${REPO}`,
      });
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.scheduledWorkRequest.updateMany).toHaveBeenCalledWith({
        data: { isActive: false, version: { increment: 1 } },
        where: { id: SCHEDULE, isActive: true, teamId: TEAM },
      });
      expect(ctx.temporal.syncWorkRequestSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ paused: true })
      );
    });

    it('leaves nothing to pause when no schedule is stranded', async () => {
      expect((await share([OTHER_TEAM])).statusCode).toBe(200);
      expect(ctx.prisma.scheduledWorkRequest.updateMany).not.toHaveBeenCalled();
      expect(ctx.temporal.syncWorkRequestSchedule).not.toHaveBeenCalled();
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
