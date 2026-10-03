import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const approvedRepositoryHosts = vi.fn();
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  approvedRepositoryHosts: () => approvedRepositoryHosts(),
}));

vi.mock('@auto-swe/shared/lib/crypto', () => ({
  decryptSecret: () => '',
  encryptSecret: (s: string) => ({
    authTag: new Uint8Array([1]),
    ciphertext: new Uint8Array([2]),
    keyVersion: 1,
    lastFour: s.trimEnd().slice(-4),
    nonce: new Uint8Array([3]),
  }),
}));

const resolveGitHubConfig = vi.fn();
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: () => resolveGitHubConfig(),
}));

const { githubHostCredentialRoutes } = await import('./githubHostCredentials.js');

const ID = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer fake-jwt' };
const BASE = '/api/v1/platform/github-host-credentials';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();

function row(over: Record<string, unknown> = {}) {
  return {
    appId: null,
    appPrivateKeyAuthTag: null,
    appPrivateKeyCiphertext: null,
    appPrivateKeyKeyVersion: null,
    appPrivateKeyLastFour: null,
    appPrivateKeyNonce: null,
    createdAt: new Date('2026-09-30'),
    host: 'ghe.corp',
    id: ID,
    tokenAuthTag: new Uint8Array([1]),
    tokenCiphertext: new Uint8Array([2]),
    tokenKeyVersion: 1,
    tokenLastFour: 'abcd',
    tokenNonce: new Uint8Array([3]),
    updatedAt: new Date('2026-09-30'),
    ...over,
  };
}

const appRow = (over: Record<string, unknown> = {}) =>
  row({
    appId: '42',
    appPrivateKeyAuthTag: new Uint8Array([1]),
    appPrivateKeyCiphertext: new Uint8Array([2]),
    appPrivateKeyKeyVersion: 1,
    appPrivateKeyLastFour: 'KEY-',
    appPrivateKeyNonce: new Uint8Array([3]),
    ...over,
  });

async function buildApp(role: string) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    gitHubHostCredential: {
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(githubHostCredentialRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

describe('githubHostCredentialRoutes', () => {
  let admin: Awaited<ReturnType<typeof buildApp>>;
  let engineer: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    admin = await buildApp('ADMIN');
    engineer = await buildApp('ENGINEER');
  });
  afterAll(async () => {
    await admin.app.close();
    await engineer.app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    approvedRepositoryHosts.mockResolvedValue(['github.com', 'api.github.com', 'ghe.corp']);
    resolveGitHubConfig.mockResolvedValue({
      apiUrl: 'https://ghe.instance/api/v3',
      baseUrl: 'https://ghe.instance',
    });
  });

  const post = (payload: object) =>
    admin.app.inject({ headers: AUTH, method: 'POST', payload, url: BASE });
  const patch = (payload: object) =>
    admin.app.inject({ headers: AUTH, method: 'PATCH', payload, url: `${BASE}/${ID}` });

  it('refuses every operation to a non-ADMIN', async () => {
    const calls = [
      engineer.app.inject({ headers: AUTH, method: 'GET', url: BASE }),
      engineer.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { host: 'ghe.corp', token: 'pat' },
        url: BASE,
      }),
      engineer.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { token: 'p' },
        url: `${BASE}/${ID}`,
      }),
      engineer.app.inject({ headers: AUTH, method: 'DELETE', url: `${BASE}/${ID}` }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(403);
    }
    expect(engineer.prisma.gitHubHostCredential.create).not.toHaveBeenCalled();
  });

  it('lists what is set and the last four, never a secret', async () => {
    admin.prisma.gitHubHostCredential.findMany.mockResolvedValue([appRow()]);
    const res = await admin.app.inject({ headers: AUTH, method: 'GET', url: BASE });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toEqual([
      {
        appId: '42',
        appPrivateKeyLastFour: 'KEY-',
        createdAt: '2026-09-30T00:00:00.000Z',
        hasAppPrivateKey: true,
        hasToken: true,
        host: 'ghe.corp',
        id: ID,
        tokenLastFour: 'abcd',
        updatedAt: '2026-09-30T00:00:00.000Z',
      },
    ]);
    expect(res.payload).not.toMatch(/ciphertext|nonce|authTag/i);
  });

  it('creates an encrypted PAT credential, audits it without secrets, and echoes none', async () => {
    admin.prisma.gitHubHostCredential.create.mockResolvedValue(row());
    const res = await post({ host: 'ghe.corp', token: 'ghp_secret_abcd' });
    expect(res.statusCode).toBe(201);
    const data = admin.prisma.gitHubHostCredential.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ appId: null, host: 'ghe.corp', tokenLastFour: 'abcd' });
    expect(data.tokenCiphertext).toEqual(new Uint8Array([2]));
    expect(res.payload).not.toContain('ghp_secret');
    expect(JSON.stringify(admin.prisma.configAuditLog.create.mock.calls)).not.toContain(
      'ghp_secret'
    );
    expect(admin.prisma.configAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('creates a GitHub App credential from an id and a PEM private key', async () => {
    admin.prisma.gitHubHostCredential.create.mockResolvedValue(appRow({ tokenCiphertext: null }));
    const res = await post({ appId: '42', appPrivateKey: PEM, host: 'ghe.corp' });
    expect(res.statusCode).toBe(201);
    const data = admin.prisma.gitHubHostCredential.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ appId: '42', tokenCiphertext: null });
    expect(data.appPrivateKeyCiphertext).toEqual(new Uint8Array([2]));
  });

  it('keys the row by the host family, so api.github.com is github.com', async () => {
    admin.prisma.gitHubHostCredential.create.mockResolvedValue(row({ host: 'github.com' }));
    const res = await post({ host: 'api.github.com', token: 'pat' });
    expect(res.statusCode).toBe(201);
    expect(admin.prisma.gitHubHostCredential.create.mock.calls[0][0].data.host).toBe('github.com');
  });

  it('allows credentials for a data-residency tenant (unlike a webhook secret)', async () => {
    approvedRepositoryHosts.mockResolvedValue(['acme.ghe.com']);
    admin.prisma.gitHubHostCredential.create.mockResolvedValue(row({ host: 'acme.ghe.com' }));
    const res = await post({ host: 'api.acme.ghe.com', token: 'pat' });
    expect(res.statusCode).toBe(201);
    expect(admin.prisma.gitHubHostCredential.create.mock.calls[0][0].data.host).toBe(
      'acme.ghe.com'
    );
  });

  it("refuses the instance's own host, even spelled by its API name", async () => {
    resolveGitHubConfig.mockResolvedValue({
      apiUrl: 'https://api.github.com',
      baseUrl: 'https://github.com',
    });
    for (const host of ['github.com', 'api.github.com']) {
      const res = await post({ host, token: 'pat' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('HOST_IS_INSTANCE');
    }
    expect(admin.prisma.gitHubHostCredential.create).not.toHaveBeenCalled();
  });

  it('refuses a host that is not approved', async () => {
    const res = await post({ host: 'evil.example', token: 'pat' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('HOST_NOT_APPROVED');
    expect(admin.prisma.gitHubHostCredential.create).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing', {}, 'NO_CREDENTIAL'],
    ['an App id with no key', { appId: '42' }, 'INCOMPLETE_APP'],
    ['a key with no App id', { appPrivateKey: PEM }, 'INCOMPLETE_APP'],
  ])('refuses %s', async (_n, extra, code) => {
    const res = await post({ host: 'ghe.corp', ...extra });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe(code);
  });

  it('refuses a private key that is not a PEM key, and a token with edge whitespace', async () => {
    expect(
      (await post({ appId: '42', appPrivateKey: 'not a key', host: 'ghe.corp' })).statusCode
    ).toBe(400);
    expect((await post({ host: 'ghe.corp', token: 'pat\n' })).statusCode).toBe(400);
    expect((await post({ appId: 'abc', appPrivateKey: PEM, host: 'ghe.corp' })).statusCode).toBe(
      400
    );
  });

  it('refuses a trailing-dot hostname, which no URL comparison treats as the same host', async () => {
    approvedRepositoryHosts.mockResolvedValue(['ghe.corp.', 'ghe.corp']);
    for (const host of ['ghe.corp.', 'ghe.corp.:8443']) {
      expect((await post({ host, token: 'pat' })).statusCode).toBe(400);
    }
    expect(admin.prisma.gitHubHostCredential.create).not.toHaveBeenCalled();
  });

  it('answers 409 for a second row for the same host', async () => {
    admin.prisma.gitHubHostCredential.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002', name: 'PrismaClientKnownRequestError' })
    );
    const res = await post({ host: 'ghe.corp', token: 'pat' });
    expect(res.statusCode).toBe(409);
  });

  it('rotates one secret and leaves the others, auditing last-fours only', async () => {
    admin.prisma.gitHubHostCredential.findUnique.mockResolvedValue(appRow());
    admin.prisma.gitHubHostCredential.update.mockResolvedValue(appRow({ tokenLastFour: 'wxyz' }));
    const res = await patch({ token: 'new-token-wxyz' });
    expect(res.statusCode).toBe(200);
    const data = admin.prisma.gitHubHostCredential.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ tokenLastFour: 'wxyz' });
    expect(data).not.toHaveProperty('appId');
    expect(data).not.toHaveProperty('appPrivateKeyCiphertext');
    const audit = JSON.stringify(admin.prisma.configAuditLog.create.mock.calls);
    expect(audit).not.toContain('new-token');
  });

  it('clears the PAT while the App remains, and refuses to clear the last credential', async () => {
    admin.prisma.gitHubHostCredential.findUnique.mockResolvedValue(appRow());
    admin.prisma.gitHubHostCredential.update.mockResolvedValue(appRow({ tokenCiphertext: null }));
    expect((await patch({ token: null })).statusCode).toBe(200);
    expect(admin.prisma.gitHubHostCredential.update.mock.calls[0][0].data).toMatchObject({
      tokenCiphertext: null,
      tokenLastFour: null,
    });

    admin.prisma.gitHubHostCredential.update.mockClear();
    admin.prisma.gitHubHostCredential.findUnique.mockResolvedValue(row());
    const res = await patch({ token: null });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('NO_CREDENTIAL');
    expect(admin.prisma.gitHubHostCredential.update).not.toHaveBeenCalled();
  });

  it('keeps the App whole: its id and key are set or cleared together', async () => {
    admin.prisma.gitHubHostCredential.findUnique.mockResolvedValue(appRow());
    const res = await patch({ appId: null });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INCOMPLETE_APP');
    expect((await patch({ appId: null, appPrivateKey: null })).statusCode).toBe(200);
  });

  it('refuses to edit a row whose host lost its approval', async () => {
    admin.prisma.gitHubHostCredential.findUnique.mockResolvedValue(row());
    approvedRepositoryHosts.mockResolvedValue(['github.com']);
    const res = await patch({ token: 'new' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('HOST_NOT_APPROVED');
  });

  it('answers 404 for an unknown id, and deletes with an audit entry', async () => {
    admin.prisma.gitHubHostCredential.findUnique.mockResolvedValue(null);
    expect((await patch({ token: 'new' })).statusCode).toBe(404);

    admin.prisma.gitHubHostCredential.delete.mockResolvedValue(row());
    const res = await admin.app.inject({ headers: AUTH, method: 'DELETE', url: `${BASE}/${ID}` });
    expect(res.statusCode).toBe(204);
    expect(admin.prisma.configAuditLog.create).toHaveBeenCalledTimes(1);
  });
});
