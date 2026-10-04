import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const approvedRepositoryHosts = vi.fn();
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  approvedRepositoryHosts: () => approvedRepositoryHosts(),
}));

vi.mock('@auto-swe/shared/lib/crypto', () => ({
  decryptSecret: () => '',
  encryptSecret: () => ({}),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));

vi.mock('@auto-swe/shared/lib/tenantGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/tenantGuard')>()),
  runUnscoped: (_reason: string, _models: string[], fn: () => unknown) => fn(),
}));

const { githubInstallationRoutes } = await import('./githubInstallations.js');

const AUTH = { authorization: 'Bearer fake-jwt' };
const BASE = '/api/v1/platform/github-installations';

async function buildApp(role: string) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    connection: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubInstallation: {
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(githubInstallationRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

describe('githubInstallationRoutes and the host an installation lives on', () => {
  let admin: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    admin = await buildApp('ADMIN');
  });
  afterAll(() => admin.app.close());
  beforeEach(() => {
    vi.clearAllMocks();
    approvedRepositoryHosts.mockResolvedValue(['github.com', 'api.github.com', 'ghe.corp']);
    admin.prisma.gitHubInstallation.create.mockImplementation(async ({ data }) => ({
      id: 'row',
      ...data,
    }));
  });

  const create = (payload: Record<string, unknown>) =>
    admin.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { accountLogin: 'acme', installationId: '4242', ...payload },
      url: BASE,
    });

  it("records an installation with no host on the instance's own host (empty)", async () => {
    expect((await create({})).statusCode).toBe(201);
    expect(admin.prisma.gitHubInstallation.create.mock.calls[0][0].data).toMatchObject({
      host: '',
      installationId: '4242',
    });
  });

  it("treats the instance's own host, however spelled, as the empty host", async () => {
    for (const host of ['github.com', 'api.github.com']) {
      admin.prisma.gitHubInstallation.create.mockClear();
      expect((await create({ host })).statusCode).toBe(201);
      expect(admin.prisma.gitHubInstallation.create.mock.calls[0][0].data.host).toBe('');
    }
  });

  it('records an installation on an approved other host under that host family', async () => {
    expect((await create({ host: 'ghe.corp' })).statusCode).toBe(201);
    expect(admin.prisma.gitHubInstallation.create.mock.calls[0][0].data.host).toBe('ghe.corp');
  });

  it('refuses a host that is not approved', async () => {
    const res = await create({ host: 'evil.example' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('HOST_NOT_APPROVED');
    expect(admin.prisma.gitHubInstallation.create).not.toHaveBeenCalled();
  });

  it('answers 409 naming the host when that host already has the id', async () => {
    admin.prisma.gitHubInstallation.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002', name: 'PrismaClientKnownRequestError' })
    );
    const res = await create({ host: 'ghe.corp' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error.message).toContain('ghe.corp');
  });

  it('cannot move an installation to another host: the host is not editable', async () => {
    admin.prisma.gitHubInstallation.update.mockResolvedValue({ id: 'row' });
    await admin.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { accountLogin: 'renamed', host: 'ghe.corp' },
      url: `${BASE}/11111111-1111-4111-8111-111111111111`,
    });
    expect(admin.prisma.gitHubInstallation.update.mock.calls[0][0].data).toEqual({
      accountLogin: 'renamed',
    });
  });

  it("an admin's choice about isActive clears the webhook's retirement reason", async () => {
    admin.prisma.gitHubInstallation.update.mockResolvedValue({ id: 'row' });
    await admin.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { isActive: false },
      url: `${BASE}/11111111-1111-4111-8111-111111111111`,
    });
    expect(admin.prisma.gitHubInstallation.update.mock.calls[0][0].data).toEqual({
      isActive: false,
      retiredReason: null,
    });
  });
});
