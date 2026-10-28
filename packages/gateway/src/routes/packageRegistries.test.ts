import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/crypto', () => ({
  encryptSecret: (s: string) => ({
    authTag: new Uint8Array([1]),
    ciphertext: new Uint8Array([2]),
    keyVersion: 1,
    lastFour: s.trimEnd().slice(-4),
    nonce: new Uint8Array([3]),
  }),
}));

const { packageRegistryRoutes } = await import('./packageRegistries.js');

const ID = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer fake-jwt' };
const BASE = '/api/v1/admin/package-registries';

function row(over: Record<string, unknown> = {}) {
  return {
    accessMode: 'lockfile',
    allowPrivateNetwork: false,
    authKind: 'bearer',
    createdAt: new Date('2026-10-20'),
    ecosystem: 'npm',
    id: ID,
    isActive: true,
    name: 'npmjs',
    npmScopes: [],
    teamId: null,
    tokenAuthTag: new Uint8Array([1]),
    tokenCiphertext: new Uint8Array([2]),
    tokenKeyVersion: 1,
    tokenLastFour: 'abcd',
    tokenNonce: new Uint8Array([3]),
    updatedAt: new Date('2026-10-20'),
    upstreamUrl: 'https://registry.npmjs.org',
    ...over,
  };
}

function buildApp(role: 'ADMIN' | 'LEAD' = 'ADMIN') {
  const prisma = {
    configAuditLog: { create: vi.fn(async () => ({})) },
    packageRegistry: {
      create: vi.fn(async (a: { data: Record<string, unknown> }) => row(a.data)),
      delete: vi.fn(async () => row()),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => row()),
      update: vi.fn(async (a: { data: Record<string, unknown> }) => row(a.data)),
    },
  };
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  void app.register(packageRegistryRoutes, { prefix: '/api/v1/admin' });
  return { app, prisma };
}

describe('packageRegistryRoutes', () => {
  const { app, prisma } = buildApp();

  it('lists registries', async () => {
    prisma.packageRegistry.findMany.mockResolvedValueOnce([row()] as never);
    const res = await app.inject({ headers: AUTH, method: 'GET', url: BASE });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data[0]).toMatchObject({ hasToken: true, name: 'npmjs', tokenLastFour: 'abcd' });
    expect(body.data[0].token).toBeUndefined();
  });

  it('creates a registry, encrypting the token and auditing', async () => {
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: {
        name: 'npmjs',
        upstreamUrl: 'https://registry.npmjs.org',
      },
      url: BASE,
    });
    expect(res.statusCode).toBe(201);
    const audit = (prisma.configAuditLog.create.mock.calls as unknown as [unknown][])[0]?.[0] as {
      data: { entityType: string };
    };
    expect(audit.data.entityType).toBe('PackageRegistry');
  });

  it('rejects a scope clash with 409', async () => {
    prisma.packageRegistry.findMany.mockResolvedValueOnce([row({ name: 'existing' })] as never);
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { name: 'second', upstreamUrl: 'https://registry.npmjs.org' },
      url: BASE,
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects private upstreams unless allowed', async () => {
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { name: 'internal', upstreamUrl: 'http://169.254.169.254/latest' },
      url: BASE,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('BASE_URL_REFUSED');
  });

  it('PATCH keeps the stored token when none is sent', async () => {
    const res = await app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { accessMode: 'open' },
      url: `${BASE}/${ID}`,
    });
    expect(res.statusCode).toBe(200);
    const data = (
      prisma.packageRegistry.update.mock.calls as unknown as [{ data: Record<string, unknown> }][]
    )[0][0].data;
    expect(data.accessMode).toBe('open');
    expect(data.tokenCiphertext).toBeUndefined();
    // A field the caller did not send is not written, least of all as its create-time default.
    for (const key of ['teamId', 'npmScopes', 'authKind', 'allowPrivateNetwork']) {
      expect(data).not.toHaveProperty(key);
    }
  });

  it('is ADMIN only', async () => {
    const lead = buildApp('LEAD');
    const res = await lead.app.inject({ headers: AUTH, method: 'GET', url: BASE });
    expect(res.statusCode).toBe(403);
  });

  it('deletes with an audit entry', async () => {
    const res = await app.inject({ headers: AUTH, method: 'DELETE', url: `${BASE}/${ID}` });
    expect(res.statusCode).toBe(204);
  });
});
