import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveUserCredentialPolicy = vi.fn();
vi.mock('@auto-swe/shared/lib/connectionCredential', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  encryptCredentialToken: (t: string) => ({
    tokenAuthTag: new Uint8Array([1]),
    tokenCiphertext: new Uint8Array([2]),
    tokenKeyVersion: 1,
    tokenLastFour: t.slice(-4),
    tokenNonce: new Uint8Array([3]),
  }),
  resolveUserCredentialPolicy: () => resolveUserCredentialPolicy(),
}));

const fetchOwnRepoPermission = vi.fn();
vi.mock('@auto-swe/shared/lib/githubPermission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/githubPermission')>()),
  fetchOwnRepoPermission: (...a: unknown[]) => fetchOwnRepoPermission(...a),
}));

const recordRepoPermission = vi.fn();
vi.mock('@auto-swe/shared/lib/repoAccessProjection', () => ({
  recordRepoPermission: (...a: unknown[]) => recordRepoPermission(...a),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));

const { connectionCredentialRoutes } = await import('./connectionCredentials.js');

const CONN = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer fake-jwt' };

function repoRow(over: Record<string, unknown> = {}) {
  return {
    githubApiUrl: null,
    githubUrl: null,
    id: CONN,
    isActive: true,
    organizationName: 'acme',
    repoName: 'payments',
    team: { isActive: true, memberships: [{ userId: 'user-1' }] },
    type: 'git_repo',
    ...over,
  };
}

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const prisma = {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: { findUnique: vi.fn() },
    connectionCredential: {
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
  };
  const auth = {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' }),
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', auth as unknown as never);
  await app.register(connectionCredentialRoutes, { prefix: '/api/v1/repositories' });
  await app.ready();
  return { app, prisma };
}

describe('connectionCredentialRoutes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    resolveUserCredentialPolicy.mockResolvedValue({ enabled: true, hosts: ['github.com'] });
    fetchOwnRepoPermission.mockResolvedValue({ ok: true, permission: 'write' });
    recordRepoPermission.mockResolvedValue({ written: true });
    ctx.prisma.connection.findUnique.mockResolvedValue(repoRow());
    ctx.prisma.connectionCredential.findUnique.mockResolvedValue(null);
    ctx.prisma.connectionCredential.upsert.mockResolvedValue({
      createdAt: new Date('2026-09-30'),
      id: 'cred-1',
      tokenLastFour: 'abcd',
      updatedAt: new Date('2026-09-30'),
    });
    ctx.prisma.configAuditLog.create.mockResolvedValue({});
  });

  function save(token = 'ghp_secretabcd') {
    return ctx.app.inject({
      headers: AUTH,
      method: 'PUT',
      payload: { token },
      url: `/api/v1/repositories/${CONN}/credential`,
    });
  }

  it('verifies the token with GitHub, stores it encrypted, and never echoes it', async () => {
    const res = await save();
    expect(res.statusCode).toBe(201);
    expect(res.payload).not.toContain('ghp_secretabcd');
    expect(JSON.parse(res.payload).data).toMatchObject({ lastFour: 'abcd', permission: 'write' });

    expect(fetchOwnRepoPermission).toHaveBeenCalledWith({
      apiUrl: 'https://api.github.com',
      organizationName: 'acme',
      repoName: 'payments',
      token: 'ghp_secretabcd',
    });
    const upsert = ctx.prisma.connectionCredential.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ connectionId_userId: { connectionId: CONN, userId: 'user-1' } });
    expect(JSON.stringify(upsert.create)).not.toContain('ghp_secretabcd');
    // Bound to where it was verified, so a repointed repository stops using it.
    expect(upsert.create).toMatchObject({
      apiOrigin: 'https://api.github.com',
      webOrigin: 'https://github.com',
    });
    // The verification is a real answer about this user's runs' identity.
    expect(recordRepoPermission).toHaveBeenCalledWith(expect.anything(), {
      connectionId: CONN,
      lookup: { ok: true, permission: 'write' },
      userId: 'user-1',
    });
    expect(ctx.prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'CREATE', entityType: 'ConnectionCredential' }),
    });
    const audit = JSON.stringify(ctx.prisma.configAuditLog.create.mock.calls[0][0]);
    expect(audit).not.toContain('ghp_secretabcd');
  });

  it('answers 200 and audits an update when replacing a saved token', async () => {
    ctx.prisma.connectionCredential.findUnique.mockResolvedValue({
      id: 'cred-1',
      tokenLastFour: 'zzzz',
    });
    const res = await save();
    expect(res.statusCode).toBe(200);
    expect(ctx.prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'UPDATE' }),
    });
  });

  it('refuses to save while the feature is off', async () => {
    resolveUserCredentialPolicy.mockResolvedValue({ enabled: false, hosts: ['github.com'] });
    const res = await save();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.code).toBe('USER_CREDENTIALS_DISABLED');
    expect(fetchOwnRepoPermission).not.toHaveBeenCalled();
  });

  it('refuses a repository outside the caller’s teams as not found', async () => {
    ctx.prisma.connection.findUnique.mockResolvedValue(
      repoRow({ team: { isActive: true, memberships: [] } })
    );
    const res = await save();
    expect(res.statusCode).toBe(404);
    expect(fetchOwnRepoPermission).not.toHaveBeenCalled();
  });

  it('refuses a non-git connection', async () => {
    ctx.prisma.connection.findUnique.mockResolvedValue(repoRow({ type: 'http_api' }));
    expect((await save()).statusCode).toBe(404);
  });

  it('never sends the token to a host the admin has not allowed', async () => {
    // A team lead pointed this repository at a GHE host nobody approved.
    ctx.prisma.connection.findUnique.mockResolvedValue(
      repoRow({ githubApiUrl: 'https://ghe.corp/api/v3', githubUrl: 'https://ghe.corp' })
    );
    const res = await save();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('HOST_NOT_ALLOWED');
    expect(fetchOwnRepoPermission).not.toHaveBeenCalled();
  });

  it('accepts a GHE host once the admin lists it', async () => {
    resolveUserCredentialPolicy.mockResolvedValue({ enabled: true, hosts: ['ghe.corp'] });
    ctx.prisma.connection.findUnique.mockResolvedValue(
      repoRow({ githubApiUrl: 'https://ghe.corp/api/v3', githubUrl: 'https://ghe.corp' })
    );
    expect((await save()).statusCode).toBe(201);
    expect(fetchOwnRepoPermission.mock.calls[0][0].apiUrl).toBe('https://ghe.corp/api/v3');
  });

  it('refuses a token GitHub rejects, and one whose owner cannot write', async () => {
    fetchOwnRepoPermission.mockResolvedValue({ failure: 'repo-not-found', ok: false });
    let res = await save();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('CREDENTIAL_REJECTED');

    fetchOwnRepoPermission.mockResolvedValue({ ok: true, permission: 'read' });
    res = await save();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INSUFFICIENT_PERMISSION');
    expect(ctx.prisma.connectionCredential.upsert).not.toHaveBeenCalled();
  });

  it('reports GitHub being unreachable as retryable, saving nothing', async () => {
    fetchOwnRepoPermission.mockResolvedValue({ failure: 'unavailable', ok: false });
    const res = await save();
    expect(res.statusCode).toBe(503);
    expect(ctx.prisma.connectionCredential.upsert).not.toHaveBeenCalled();
  });

  it('rejects a token containing whitespace', async () => {
    const res = await save('ghp_abc\ndef');
    expect(res.statusCode).toBe(400);
    expect(fetchOwnRepoPermission).not.toHaveBeenCalled();
  });

  it('deletes only the caller’s own token, even with the feature off', async () => {
    resolveUserCredentialPolicy.mockResolvedValue({ enabled: false, hosts: [] });
    ctx.prisma.connectionCredential.findUnique.mockResolvedValue({
      id: 'cred-1',
      tokenLastFour: 'abcd',
    });
    const res = await ctx.app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/repositories/${CONN}/credential`,
    });
    expect(res.statusCode).toBe(204);
    expect(ctx.prisma.connectionCredential.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connectionId_userId: { connectionId: CONN, userId: 'user-1' } },
      })
    );
    expect(ctx.prisma.connectionCredential.delete).toHaveBeenCalledWith({
      where: { id: 'cred-1' },
    });
  });

  it('answers 404 when there is nothing to delete', async () => {
    const res = await ctx.app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/repositories/${CONN}/credential`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists the caller’s own credentials with the policy, without any token', async () => {
    ctx.prisma.connectionCredential.findMany.mockResolvedValue([
      {
        connectionId: CONN,
        createdAt: new Date('2026-09-30'),
        tokenLastFour: 'abcd',
        updatedAt: new Date('2026-09-30'),
      },
    ]);
    const res = await ctx.app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/repositories/credentials/mine',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload).data;
    expect(body).toMatchObject({ enabled: true, hosts: ['github.com'] });
    expect(body.credentials).toEqual([
      expect.objectContaining({ connectionId: CONN, lastFour: 'abcd' }),
    ]);
    expect(ctx.prisma.connectionCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } })
    );
  });
});
