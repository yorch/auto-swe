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

  describe('go registries', () => {
    const goPost = (payload: Record<string, unknown>) =>
      app.inject({
        headers: AUTH,
        method: 'POST',
        payload: {
          ecosystem: 'go',
          name: 'goproxy',
          upstreamUrl: 'https://proxy.golang.org',
          ...payload,
        },
        url: BASE,
      });
    const lastWhere = () =>
      (prisma.packageRegistry.findMany.mock.calls.at(-1) as unknown as [{ where: object }])[0]
        .where;

    it('creates a go row, filtering the clash query by ecosystem', async () => {
      prisma.packageRegistry.findMany.mockClear();
      const res = await goPost({});
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.payload).data.ecosystem).toBe('go');
      expect(lastWhere()).toMatchObject({ ecosystem: 'go', isActive: true, teamId: null });
      const audit = (prisma.configAuditLog.create.mock.calls.at(-1) as unknown as [unknown])[0] as {
        data: { afterJson: { ecosystem: string } };
      };
      expect(audit.data.afterJson.ecosystem).toBe('go');
    });

    it('filters the npm clash query by ecosystem too', async () => {
      await app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { name: 'npmjs', upstreamUrl: 'https://registry.npmjs.org' },
        url: BASE,
      });
      expect(lastWhere()).toMatchObject({ ecosystem: 'npm' });
    });

    it('refuses scopes on a go row, on create and on PATCH', async () => {
      const created = await goPost({ npmScopes: ['@acme'] });
      expect(created.statusCode).toBe(400);
      expect(JSON.parse(created.payload).error.code).toBe('VALIDATION_ERROR');

      prisma.packageRegistry.findUnique.mockResolvedValueOnce(row({ ecosystem: 'go' }) as never);
      const patched = await app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { npmScopes: ['@acme'] },
        url: `${BASE}/${ID}`,
      });
      expect(patched.statusCode).toBe(400);
      expect(JSON.parse(patched.payload).error.code).toBe('VALIDATION_ERROR');

      prisma.packageRegistry.findUnique.mockResolvedValueOnce(row({ ecosystem: 'go' }) as never);
      const cleared = await app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { npmScopes: [] },
        url: `${BASE}/${ID}`,
      });
      expect(cleared.statusCode).toBe(200);
    });

    it('lets an npm default and a go default of one team coexist', async () => {
      const teamId = '22222222-2222-4222-8222-222222222222';
      // The clash query is ecosystem-filtered, so the npm default is never returned for a go candidate.
      prisma.packageRegistry.findMany.mockImplementation((async (a: {
        where: { ecosystem: string };
      }) => (a.where.ecosystem === 'npm' ? [row({ teamId })] : [])) as never);
      try {
        const go = await goPost({ teamId });
        expect(go.statusCode).toBe(201);
        const npm = await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { name: 'second-npm', teamId, upstreamUrl: 'https://registry.npmjs.org' },
          url: BASE,
        });
        expect(npm.statusCode).toBe(409);
        prisma.packageRegistry.findMany.mockImplementation((async (a: {
          where: { ecosystem: string };
        }) => (a.where.ecosystem === 'go' ? [row({ ecosystem: 'go', teamId })] : [])) as never);
        const npmOk = await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { name: 'team-npm', teamId, upstreamUrl: 'https://registry.npmjs.org' },
          url: BASE,
        });
        expect(npmOk.statusCode).toBe(201);
      } finally {
        prisma.packageRegistry.findMany.mockImplementation((async () => []) as never);
      }
    });

    it('rejects a second go default for one team with 409', async () => {
      prisma.packageRegistry.findMany.mockResolvedValueOnce([
        row({ ecosystem: 'go', name: 'first-go' }),
      ] as never);
      const res = await goPost({ name: 'second-go' });
      expect(res.statusCode).toBe(409);
      const err = JSON.parse(res.payload).error;
      expect(err.code).toBe('PACKAGE_REGISTRY_CLASH');
      expect(err.message).toContain('default Go registry');
    });

    it('lets a global go default and a team go default coexist', async () => {
      const teamId = '22222222-2222-4222-8222-222222222222';
      // The team query is scoped to that team, so the global row is not returned.
      prisma.packageRegistry.findMany.mockResolvedValueOnce([] as never);
      const res = await goPost({ name: 'team-go', teamId });
      expect(res.statusCode).toBe(201);
      expect(lastWhere()).toMatchObject({ ecosystem: 'go', teamId });
    });

    it.each([
      ['credentials', 'https://user:pw@proxy.golang.org'],
      ['a query string', 'https://proxy.golang.org?x=1'],
      ['a fragment', 'https://proxy.golang.org/#frag'],
    ])('refuses a go URL with %s', async (_label, upstreamUrl) => {
      const res = await goPost({ upstreamUrl });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('BASE_URL_REFUSED');
    });

    it('refuses the same URL shapes on a go PATCH', async () => {
      prisma.packageRegistry.findUnique.mockResolvedValueOnce(row({ ecosystem: 'go' }) as never);
      const res = await app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { upstreamUrl: 'https://proxy.golang.org/?x=1' },
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('BASE_URL_REFUSED');
    });

    it('still accepts those URL shapes for npm', async () => {
      for (const upstreamUrl of [
        'https://user:pw@registry.example.com',
        'https://registry.example.com?x=1',
        'https://registry.example.com/#frag',
      ]) {
        const res = await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { name: 'npm-odd', upstreamUrl },
          url: BASE,
        });
        expect(res.statusCode).toBe(201);
      }
    });

    it('cannot change the ecosystem through PATCH', async () => {
      prisma.packageRegistry.update.mockClear();
      const res = await app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { ecosystem: 'go', name: 'renamed' },
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(200);
      const data = (
        prisma.packageRegistry.update.mock.calls as unknown as [{ data: Record<string, unknown> }][]
      )[0][0].data;
      expect(data).not.toHaveProperty('ecosystem');
      expect(lastWhere()).toMatchObject({ ecosystem: 'npm' });
    });
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
