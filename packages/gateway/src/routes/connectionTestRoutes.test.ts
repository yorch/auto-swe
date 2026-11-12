import Fastify, { type FastifyPluginAsync } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "test this connection" endpoints beside the connections they test: who may call each, what
 * a missing row answers, and that the result is the probe's own — the probes' logic is covered in
 * `connectionProbes.test.ts`.
 */
const probeRepositoryAccess = vi.fn();
const probeHostCredential = vi.fn();
const probeApproverApp = vi.fn();
const probeRegistryRow = vi.fn();
vi.mock('../lib/connectionProbes.js', () => ({
  failed: (name: string, detail: string) => ({
    checks: [{ detail, name, ok: false }],
    detail,
    durationMs: 0,
    ok: false,
  }),
  probeApproverApp: (...args: unknown[]) => probeApproverApp(...args),
  probeHostCredential: (...args: unknown[]) => probeHostCredential(...args),
  probePackageRegistry: vi.fn(),
  probeRegistryRow: (...args: unknown[]) => probeRegistryRow(...args),
  probeRepositoryAccess: (...args: unknown[]) => probeRepositoryAccess(...args),
  summarize: vi.fn(),
}));

const checkAllConnections = vi.fn();
vi.mock('../lib/connectionHealth.js', () => ({
  checkAllConnections: (...args: unknown[]) => checkAllConnections(...args),
}));

const approvedRepositoryHosts = vi.fn();
vi.mock('@auto-swe/shared/lib/connectionCredential', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  approvedRepositoryHosts: () => approvedRepositoryHosts(),
}));

const resolveGitHubConfig = vi.fn();
vi.mock('@auto-swe/shared/lib/systemConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveGitHubConfig: () => resolveGitHubConfig(),
}));

const { githubHostCredentialRoutes } = await import('./githubHostCredentials.js');
const { githubApproverAppRoutes } = await import('./githubApproverApp.js');
const { packageRegistryRoutes } = await import('./packageRegistries.js');
const { repositoryRoutes } = await import('./repositories.js');
const { systemConfigRoutes } = await import('./systemConfig.js');

const ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const AUTH = { authorization: 'Bearer fake-jwt' };
const RESULT = { checks: [], detail: 'fine', durationMs: 1, ok: true };

async function buildApp(
  role: 'ADMIN' | 'LEAD' | 'ENGINEER',
  plugin: FastifyPluginAsync,
  prefix: string
) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    connection: { findUnique: vi.fn() },
    gitHubHostCredential: { findUnique: vi.fn() },
    organizationMembership: { findUnique: vi.fn() },
    packageRegistry: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    teamMembership: { findUnique: vi.fn() },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(plugin, { prefix });
  await app.ready();
  return { app, prisma };
}

beforeEach(() => {
  vi.resetAllMocks();
  approvedRepositoryHosts.mockResolvedValue(['ghe.corp']);
  resolveGitHubConfig.mockResolvedValue({ baseUrl: 'https://github.com' });
});

describe('POST /github-host-credentials/:id/test', () => {
  const url = `/api/v1/platform/github-host-credentials/${ID}/test`;

  it('is admin only', async () => {
    const { app } = await buildApp('LEAD', githubHostCredentialRoutes, '/api/v1/platform');
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(403);
    expect(probeHostCredential).not.toHaveBeenCalled();
  });

  it('is 404 for a row that does not exist', async () => {
    const { app, prisma } = await buildApp('ADMIN', githubHostCredentialRoutes, '/api/v1/platform');
    prisma.gitHubHostCredential.findUnique.mockResolvedValue(null);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(404);
  });

  it('tests the stored host and returns the probe result', async () => {
    const { app, prisma } = await buildApp('ADMIN', githubHostCredentialRoutes, '/api/v1/platform');
    prisma.gitHubHostCredential.findUnique.mockResolvedValue({ host: 'ghe.corp', id: ID });
    probeHostCredential.mockResolvedValue(RESULT);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: RESULT });
    expect(probeHostCredential).toHaveBeenCalledWith('ghe.corp');
  });

  it('answers a host that is no longer approved as a failed check, not an error', async () => {
    const { app, prisma } = await buildApp('ADMIN', githubHostCredentialRoutes, '/api/v1/platform');
    prisma.gitHubHostCredential.findUnique.mockResolvedValue({ host: 'old.corp', id: ID });
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(false);
    expect(res.json().data.detail).toContain('github.repositoryHosts');
    expect(probeHostCredential).not.toHaveBeenCalled();
  });
});

describe('POST /github-approver-app/test', () => {
  const url = '/api/v1/integrations/github-approver-app/test';

  it('is admin only', async () => {
    const { app } = await buildApp('ENGINEER', githubApproverAppRoutes, '/api/v1/integrations');
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(403);
  });

  it('returns the probe result', async () => {
    const { app } = await buildApp('ADMIN', githubApproverAppRoutes, '/api/v1/integrations');
    probeApproverApp.mockResolvedValue(RESULT);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.json()).toEqual({ data: RESULT });
  });
});

describe('POST /package-registries/:id/test', () => {
  const url = `/api/v1/admin/package-registries/${ID}/test`;

  it('is admin only', async () => {
    const { app } = await buildApp('LEAD', packageRegistryRoutes, '/api/v1/admin');
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(403);
  });

  it('is 404 for a registry that does not exist', async () => {
    const { app, prisma } = await buildApp('ADMIN', packageRegistryRoutes, '/api/v1/admin');
    prisma.packageRegistry.findUnique.mockResolvedValue(null);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(404);
  });

  it('tests the stored row', async () => {
    const { app, prisma } = await buildApp('ADMIN', packageRegistryRoutes, '/api/v1/admin');
    const row = { id: ID, upstreamUrl: 'https://registry.example.com' };
    prisma.packageRegistry.findUnique.mockResolvedValue(row);
    probeRegistryRow.mockResolvedValue(RESULT);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.json()).toEqual({ data: RESULT });
    expect(probeRegistryRow).toHaveBeenCalledWith(row);
  });
});

describe('POST /repositories/:id/test-access', () => {
  const url = `/api/v1/repositories/${ID}/test-access`;
  const repo = { defaultBranch: 'main', id: ID, teamId: TEAM_ID, type: 'git_repo' };

  it('refuses a platform ENGINEER who cannot manage the repository', async () => {
    const { app, prisma } = await buildApp('ENGINEER', repositoryRoutes, '/api/v1/repositories');
    prisma.connection.findUnique.mockResolvedValue(repo);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(403);
    expect(probeRepositoryAccess).not.toHaveBeenCalled();
  });

  it('is 404 for a connection that is not a git repository', async () => {
    const { app, prisma } = await buildApp('ADMIN', repositoryRoutes, '/api/v1/repositories');
    prisma.connection.findUnique.mockResolvedValue({ ...repo, type: 'mcp' });
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(404);
    expect(probeRepositoryAccess).not.toHaveBeenCalled();
  });

  it('refuses a lead of another team, so it cannot probe what the platform credential sees', async () => {
    const { app, prisma } = await buildApp('LEAD', repositoryRoutes, '/api/v1/repositories');
    prisma.connection.findUnique.mockResolvedValue(repo);
    prisma.teamMembership.findUnique.mockResolvedValue(null);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(403);
    expect(probeRepositoryAccess).not.toHaveBeenCalled();
  });

  it("runs the check for a lead of the repository's team, as that user", async () => {
    const { app, prisma } = await buildApp('ENGINEER', repositoryRoutes, '/api/v1/repositories');
    prisma.connection.findUnique.mockResolvedValue(repo);
    prisma.teamMembership.findUnique.mockResolvedValue({ role: 'LEAD', team: { isActive: true } });
    probeRepositoryAccess.mockResolvedValue(RESULT);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: RESULT });
    expect(probeRepositoryAccess).toHaveBeenCalledWith(prisma, repo, 'user-1');
  });

  it('lets a platform admin check any team repository', async () => {
    const { app, prisma } = await buildApp('ADMIN', repositoryRoutes, '/api/v1/repositories');
    prisma.connection.findUnique.mockResolvedValue(repo);
    probeRepositoryAccess.mockResolvedValue(RESULT);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(prisma.teamMembership.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /connections/test', () => {
  const url = '/api/v1/platform/connections/test';

  it('is admin only', async () => {
    const { app } = await buildApp('LEAD', systemConfigRoutes, '/api/v1/platform');
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(403);
    expect(checkAllConnections).not.toHaveBeenCalled();
  });

  it('runs every check with no body', async () => {
    const { app, prisma } = await buildApp('ADMIN', systemConfigRoutes, '/api/v1/platform');
    checkAllConnections.mockResolvedValue([{ id: 'github', status: 'ok' }]);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [{ id: 'github', status: 'ok' }] });
    expect(checkAllConnections).toHaveBeenCalledWith(prisma, {});
  });

  it('passes the ticket id the tracker check needs', async () => {
    const { app, prisma } = await buildApp('ADMIN', systemConfigRoutes, '/api/v1/platform');
    checkAllConnections.mockResolvedValue([]);
    await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { trackerTicketId: 'PAY-1' },
      url,
    });
    expect(checkAllConnections).toHaveBeenCalledWith(prisma, { trackerTicketId: 'PAY-1' });
  });
});
