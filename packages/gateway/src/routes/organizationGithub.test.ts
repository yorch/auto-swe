import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  admin: vi.fn(),
  baseUrl: 'https://github.com',
  clientSecret: 'private' as string | null,
  identity: vi.fn(),
  role: 'ENGINEER',
  userId: 'user-1',
  verify: vi.fn(),
}));
vi.mock('@auto-swe/shared/lib/githubInstallation', () => ({ fetchGitHubAppIdentity: h.identity }));
vi.mock('../lib/githubConnect.js', () => ({ verifyGithubInstaller: h.verify }));
vi.mock('../lib/orgAccess.js', () => ({ isOrgAdmin: h.admin }));
vi.mock('@auto-swe/shared/lib/crypto', () => ({
  deriveSubkey: () => ({ key: Buffer.alloc(32, 5), version: 1 }),
  deriveSubkeyForVersion: () => Buffer.alloc(32, 5),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    appClientId: 'client',
    appClientSecret: h.clientSecret,
    appId: '123',
    appPrivateKey: 'pem',
    baseUrl: h.baseUrl,
  }),
}));
const { organizationGithubRoutes } = await import('./organizationGithub.js');
const { signGithubConnectState } = await import('../lib/githubConnectState.js');
const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const prisma = {
  $transaction: vi.fn(),
  configAuditLog: { create: vi.fn() },
  gitHubInstallation: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
};
const AUTH = { authorization: 'Bearer test' };
let app: ReturnType<typeof Fastify>;
beforeAll(async () => {
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: h.role, sub: h.userId }),
  } as never);
  await app.register(organizationGithubRoutes, { prefix: '/api/v1' });
  await app.ready();
});
afterAll(() => app.close());
beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'ENGINEER';
  h.userId = 'user-1';
  h.admin.mockResolvedValue(true);
  h.verify.mockResolvedValue('acme');
  h.baseUrl = 'https://github.com';
  h.clientSecret = 'private';
  h.identity.mockResolvedValue({ id: '123', ok: true, slug: 'auto-swe' });
  prisma.gitHubInstallation.findUnique.mockResolvedValue(null);
  prisma.gitHubInstallation.findFirst.mockResolvedValue({
    id: ID,
    isActive: true,
    organizationId: ORG,
  });
  prisma.gitHubInstallation.findMany.mockResolvedValue([]);
  prisma.gitHubInstallation.create.mockImplementation(async ({ data }) => ({ id: ID, ...data }));
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
});
const state = (now?: number, userId = 'user-1') =>
  signGithubConnectState({ appId: '123', host: 'https://api.github.com', orgId: ORG, userId }, now);
const claim = (s = state()) =>
  app.inject({
    headers: AUTH,
    method: 'POST',
    payload: { code: 'code', installation_id: '77', state: s },
    url: '/api/v1/organizations/github/claim',
  });

describe('organization GitHub connections', () => {
  it('connects through the instance App with a signed state', async () => {
    const response = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/organizations/${ORG}/github/connect`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.url).toMatch(
      /^https:\/\/github.com\/apps\/auto-swe\/installations\/new\?state=/
    );
  });
  it('explains missing App configuration', async () => {
    h.identity.mockResolvedValue({ ok: false, reason: 'rejected' });
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          url: `/api/v1/organizations/${ORG}/github/connect`,
        })
      ).statusCode
    ).toBe(409);
  });
  it.each(['http://github.com', 'https://wrong-host.example'])(
    'refuses an unsafe GitHub web URL %s',
    async (url) => {
      h.baseUrl = url;
      const response = await app.inject({
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/organizations/${ORG}/github/connect`,
      });
      expect(response.statusCode).toBe(409);
      expect(h.identity).not.toHaveBeenCalled();
    }
  );
  it('requires OAuth client credentials before contacting GitHub', async () => {
    h.clientSecret = null;
    const response = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/organizations/${ORG}/github/connect`,
    });
    expect(response.statusCode).toBe(409);
    expect(h.identity).not.toHaveBeenCalled();
  });
  it.each(['bad', 'expired', 'other-user'])('refuses %s state before GitHub', async (kind) => {
    const s =
      kind === 'bad'
        ? `${state()}tampered`
        : kind === 'expired'
          ? state(Date.now() - 601_000)
          : state(undefined, 'other');
    expect((await claim(s)).statusCode).toBe(400);
    expect(h.verify).not.toHaveBeenCalled();
  });
  it('rechecks organization administration', async () => {
    h.admin.mockResolvedValue(false);
    expect((await claim()).statusCode).toBe(403);
    expect(h.verify).not.toHaveBeenCalled();
  });
  it('refuses an installation absent from user installations', async () => {
    h.verify.mockResolvedValue(null);
    expect((await claim()).statusCode).toBe(403);
    expect(prisma.gitHubInstallation.create).not.toHaveBeenCalled();
  });
  it.each([null, ORG, 'another-org'])(
    'refuses an already registered installation in %s',
    async (organizationId) => {
      prisma.gitHubInstallation.findUnique.mockResolvedValue({ id: ID, organizationId });
      expect((await claim()).statusCode).toBe(409);
      expect(prisma.gitHubInstallation.create).not.toHaveBeenCalled();
    }
  );
  it('conceals code exchange errors', async () => {
    h.verify.mockRejectedValue(new Error('private-token'));
    const response = await claim();
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('private-token');
  });
  it('creates a new scoped installation and audit record atomically', async () => {
    const response = await claim();
    expect(response.statusCode).toBe(201);
    expect(prisma.gitHubInstallation.create).toHaveBeenCalledWith({
      data: { accountLogin: 'acme', host: '', installationId: '77', organizationId: ORG },
    });
    expect(prisma.configAuditLog.create).toHaveBeenCalled();
    expect(response.body).not.toContain('private');
  });
  it('lists only the authorized organization', async () => {
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'GET',
          url: `/api/v1/organizations/${ORG}/github/installations`,
        })
      ).statusCode
    ).toBe(200);
    expect(prisma.gitHubInstallation.findMany).toHaveBeenCalledWith({
      orderBy: { accountLogin: 'asc' },
      where: { organizationId: ORG },
    });
  });
  it('retires without allowing reactivation or preserving webhook retirement', async () => {
    const response = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/organizations/${ORG}/github/installations/${ID}/retire`,
    });
    expect(response.statusCode).toBe(200);
    expect(prisma.gitHubInstallation.updateMany).toHaveBeenCalledWith({
      data: { isActive: false, retiredReason: null },
      where: { id: ID, organizationId: ORG },
    });
  });
  it('refuses another organization and plain members', async () => {
    h.admin.mockResolvedValue(false);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          url: `/api/v1/organizations/${ORG}/github/installations/${ID}/retire`,
        })
      ).statusCode
    ).toBe(403);
    h.admin.mockResolvedValue(true);
    prisma.gitHubInstallation.findFirst.mockResolvedValue(null);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          url: `/api/v1/organizations/${ORG}/github/installations/${ID}/retire`,
        })
      ).statusCode
    ).toBe(404);
    expect(prisma.gitHubInstallation.updateMany).not.toHaveBeenCalled();
  });
});
