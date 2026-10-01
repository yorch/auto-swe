import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const approvedRepositoryHosts = vi.fn();
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  approvedRepositoryHosts: () => approvedRepositoryHosts(),
}));

vi.mock('@auto-swe/shared/lib/crypto', () => ({
  encryptSecret: (s: string) => ({
    authTag: new Uint8Array([1]),
    ciphertext: new Uint8Array([2]),
    keyVersion: 1,
    lastFour: s.slice(-4),
    nonce: new Uint8Array([3]),
  }),
}));

const { githubWebhookSecretRoutes } = await import('./githubWebhookSecrets.js');

const ID = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer fake-jwt' };
const BASE = '/api/v1/platform/github-webhook-secrets';

function row(over: Record<string, unknown> = {}) {
  return {
    createdAt: new Date('2026-09-30'),
    host: 'ghe.corp',
    id: ID,
    secretAuthTag: new Uint8Array([1]),
    secretCiphertext: new Uint8Array([2]),
    secretKeyVersion: 1,
    secretLastFour: 'abcd',
    secretNonce: new Uint8Array([3]),
    updatedAt: new Date('2026-09-30'),
    ...over,
  };
}

async function buildApp(role: string) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    gitHubHostWebhookSecret: {
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
  await app.register(githubWebhookSecretRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

describe('githubWebhookSecretRoutes', () => {
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
  });

  it('refuses every operation to a non-ADMIN', async () => {
    const calls = [
      engineer.app.inject({ headers: AUTH, method: 'GET', url: BASE }),
      engineer.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { host: 'ghe.corp', secret: 's3cret' },
        url: BASE,
      }),
      engineer.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { secret: 's3cret' },
        url: `${BASE}/${ID}`,
      }),
      engineer.app.inject({ headers: AUTH, method: 'DELETE', url: `${BASE}/${ID}` }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(403);
    }
    expect(engineer.prisma.gitHubHostWebhookSecret.create).not.toHaveBeenCalled();
  });

  it.each(['github.com', 'api.github.com'])(
    'refuses a secret for %s, which sends no enterprise-host header',
    async (host) => {
      const res = await admin.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { host, secret: 's3cret' },
        url: BASE,
      });
      expect(res.statusCode).toBe(400);
      const error = JSON.parse(res.payload).error;
      expect(error.code).toBe('HOST_SENDS_NO_HEADER');
      expect(error.message).toContain('GitHub Enterprise Server');
      expect(admin.prisma.gitHubHostWebhookSecret.create).not.toHaveBeenCalled();
    }
  );

  it('lists hosts and last four, never the secret', async () => {
    admin.prisma.gitHubHostWebhookSecret.findMany.mockResolvedValue([row()]);
    const res = await admin.app.inject({ headers: AUTH, method: 'GET', url: BASE });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data).toEqual([
      {
        createdAt: '2026-09-30T00:00:00.000Z',
        host: 'ghe.corp',
        id: ID,
        lastFour: 'abcd',
        updatedAt: '2026-09-30T00:00:00.000Z',
      },
    ]);
    expect(res.payload).not.toMatch(/ciphertext|nonce|authTag/i);
  });

  it('creates an encrypted secret for an approved host, audits it, and echoes no secret', async () => {
    admin.prisma.gitHubHostWebhookSecret.create.mockResolvedValue(row());
    const res = await admin.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { host: 'ghe.corp', secret: 'plain-secret-1234' },
      url: BASE,
    });
    expect(res.statusCode).toBe(201);
    expect(res.payload).not.toContain('plain-secret-1234');
    const data = admin.prisma.gitHubHostWebhookSecret.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ host: 'ghe.corp', secretKeyVersion: 1, secretLastFour: '1234' });
    expect(JSON.stringify(data)).not.toContain('plain-secret');
    const audit = admin.prisma.configAuditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: 'CREATE',
      actorId: 'user-1',
      entityId: ID,
      entityType: 'GitHubHostWebhookSecret',
    });
    expect(JSON.stringify(audit)).not.toContain('plain-secret');
  });

  it('refuses a host the platform will never talk to', async () => {
    const res = await admin.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { host: 'evil.example', secret: 's3cret' },
      url: BASE,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('HOST_NOT_APPROVED');
    expect(admin.prisma.gitHubHostWebhookSecret.create).not.toHaveBeenCalled();
  });

  it.each(['GHE.corp', 'https://ghe.corp', 'ghe.corp:443', 'ghe corp'])(
    'refuses the malformed host %s',
    async (host) => {
      const res = await admin.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { host, secret: 's3cret' },
        url: BASE,
      });
      expect(res.statusCode).toBe(400);
      expect(admin.prisma.gitHubHostWebhookSecret.create).not.toHaveBeenCalled();
    }
  );

  it('refuses a secret with edge whitespace', async () => {
    const res = await admin.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { host: 'ghe.corp', secret: 's3cret\n' },
      url: BASE,
    });
    expect(res.statusCode).toBe(400);
  });

  it('answers 409 when the host already has a secret', async () => {
    admin.prisma.gitHubHostWebhookSecret.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' })
    );
    const res = await admin.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { host: 'ghe.corp', secret: 's3cret' },
      url: BASE,
    });
    expect(res.statusCode).toBe(409);
    expect(admin.prisma.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('rotates the secret and audits the change without either value', async () => {
    admin.prisma.gitHubHostWebhookSecret.findUnique.mockResolvedValue(row());
    admin.prisma.gitHubHostWebhookSecret.update.mockResolvedValue(row({ secretLastFour: 'wxyz' }));
    const res = await admin.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { secret: 'new-secret-wxyz' },
      url: `${BASE}/${ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.lastFour).toBe('wxyz');
    const audit = admin.prisma.configAuditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: 'UPDATE',
      afterJson: { host: 'ghe.corp', lastFour: 'wxyz' },
      beforeJson: { host: 'ghe.corp', lastFour: 'abcd' },
    });
  });

  it('refuses to rotate the secret of a host that is no longer approved', async () => {
    approvedRepositoryHosts.mockResolvedValue(['github.com']);
    admin.prisma.gitHubHostWebhookSecret.findUnique.mockResolvedValue(row());
    const res = await admin.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { secret: 'new-secret-wxyz' },
      url: `${BASE}/${ID}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('HOST_NOT_APPROVED');
    expect(admin.prisma.gitHubHostWebhookSecret.update).not.toHaveBeenCalled();
  });

  it('answers 404 when rotating or deleting an unknown id', async () => {
    admin.prisma.gitHubHostWebhookSecret.findUnique.mockResolvedValue(null);
    const patch = await admin.app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { secret: 's3cret' },
      url: `${BASE}/${ID}`,
    });
    expect(patch.statusCode).toBe(404);

    const { Prisma } = await import('@auto-swe/shared');
    admin.prisma.gitHubHostWebhookSecret.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('missing', {
        clientVersion: 'test',
        code: 'P2025',
      })
    );
    const del = await admin.app.inject({ headers: AUTH, method: 'DELETE', url: `${BASE}/${ID}` });
    expect(del.statusCode).toBe(404);
  });

  it('deletes and audits', async () => {
    admin.prisma.gitHubHostWebhookSecret.delete.mockResolvedValue(row());
    const res = await admin.app.inject({ headers: AUTH, method: 'DELETE', url: `${BASE}/${ID}` });
    expect(res.statusCode).toBe(204);
    expect(admin.prisma.configAuditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'DELETE',
      beforeJson: { host: 'ghe.corp', lastFour: 'abcd' },
      entityType: 'GitHubHostWebhookSecret',
    });
  });
});
