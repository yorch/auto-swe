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

/** What the scopeless cases differ on: the ecosystem, its upstream, and its refusal wording. */
const SCOPELESS = [
  {
    ecosystem: 'go',
    name: 'goproxy',
    noScopes: 'A Go registry has no scopes: it serves every module for its team',
    noun: 'Go',
    upstreamUrl: 'https://proxy.golang.org',
  },
  {
    ecosystem: 'pypi',
    name: 'pypi-proxy',
    noScopes: 'A PyPI registry has no scopes: it serves every package for its team',
    noun: 'PyPI',
    upstreamUrl: 'https://pypi.org/simple',
  },
  {
    ecosystem: 'maven',
    name: 'maven-proxy',
    noScopes: 'A Maven registry has no scopes: it serves every artifact for its team',
    noun: 'Maven',
    upstreamUrl: 'https://repo.maven.apache.org/maven2',
  },
];

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

  it('filters the npm clash query by ecosystem too', async () => {
    prisma.packageRegistry.findMany.mockClear();
    await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { name: 'npmjs', upstreamUrl: 'https://registry.npmjs.org' },
      url: BASE,
    });
    expect(
      (prisma.packageRegistry.findMany.mock.calls.at(-1) as unknown as [{ where: object }])[0].where
    ).toMatchObject({ ecosystem: 'npm' });
  });

  it('lets one team hold an npm, a go, a pypi and a maven default at once', async () => {
    const teamId = '22222222-2222-4222-8222-222222222222';
    // A stored default answers only the clash query of its own ecosystem and team.
    const stored: ReturnType<typeof row>[] = [];
    prisma.packageRegistry.findMany.mockImplementation((async (a: {
      where: { ecosystem: string; teamId: string };
    }) =>
      stored.filter(
        (r) => r.ecosystem === a.where.ecosystem && r.teamId === a.where.teamId
      )) as never);
    prisma.packageRegistry.create.mockImplementation((async (a: {
      data: Record<string, unknown>;
    }) => {
      const created = row(a.data);
      stored.push(created);
      return created;
    }) as never);
    try {
      const post = (payload: Record<string, unknown>) =>
        app.inject({ headers: AUTH, method: 'POST', payload: { teamId, ...payload }, url: BASE });
      const npm = await post({ name: 'team-npm', upstreamUrl: 'https://registry.npmjs.org' });
      const go = await post({
        ecosystem: 'go',
        name: 'team-go',
        upstreamUrl: 'https://proxy.golang.org',
      });
      const pypi = await post({
        ecosystem: 'pypi',
        name: 'team-pypi',
        upstreamUrl: 'https://pypi.org/simple',
      });
      const maven = await post({
        ecosystem: 'maven',
        name: 'team-maven',
        upstreamUrl: 'https://repo.maven.apache.org/maven2',
      });
      expect([npm.statusCode, go.statusCode, pypi.statusCode, maven.statusCode]).toEqual([
        201, 201, 201, 201,
      ]);
      const again = await post({
        ecosystem: 'pypi',
        name: 'second-pypi',
        upstreamUrl: 'https://pypi.org/simple',
      });
      expect(again.statusCode).toBe(409);
      const secondMaven = await post({
        ecosystem: 'maven',
        name: 'second-maven',
        upstreamUrl: 'https://repo.maven.apache.org/maven2',
      });
      expect(secondMaven.statusCode).toBe(409);
      expect(JSON.parse(secondMaven.payload).error.message).toContain(
        'an active default Maven registry already exists for this team'
      );
    } finally {
      prisma.packageRegistry.findMany.mockImplementation((async () => []) as never);
      prisma.packageRegistry.create.mockImplementation((async (a: {
        data: Record<string, unknown>;
      }) => row(a.data)) as never);
    }
  });

  describe.each(SCOPELESS)('$noun registries', (entry) => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        headers: AUTH,
        method: 'POST',
        payload: {
          ecosystem: entry.ecosystem,
          name: entry.name,
          upstreamUrl: entry.upstreamUrl,
          ...payload,
        },
        url: BASE,
      });
    const lastWhere = () =>
      (prisma.packageRegistry.findMany.mock.calls.at(-1) as unknown as [{ where: object }])[0]
        .where;

    it('creates a row, filtering the clash query by ecosystem', async () => {
      prisma.packageRegistry.findMany.mockClear();
      const res = await post({});
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.payload).data.ecosystem).toBe(entry.ecosystem);
      expect(lastWhere()).toMatchObject({
        ecosystem: entry.ecosystem,
        isActive: true,
        teamId: null,
      });
      const audit = (prisma.configAuditLog.create.mock.calls.at(-1) as unknown as [unknown])[0] as {
        data: { afterJson: { ecosystem: string } };
      };
      expect(audit.data.afterJson.ecosystem).toBe(entry.ecosystem);
    });

    it('refuses scopes, on create and on PATCH', async () => {
      const created = await post({ npmScopes: ['@acme'] });
      expect(created.statusCode).toBe(400);
      const createdErr = JSON.parse(created.payload).error;
      expect(createdErr.code).toBe('VALIDATION_ERROR');
      expect(createdErr.message).toBe(entry.noScopes);

      prisma.packageRegistry.findUnique.mockResolvedValueOnce(
        row({ ecosystem: entry.ecosystem }) as never
      );
      const patched = await app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { npmScopes: ['@acme'] },
        url: `${BASE}/${ID}`,
      });
      expect(patched.statusCode).toBe(400);
      expect(JSON.parse(patched.payload).error.code).toBe('VALIDATION_ERROR');

      prisma.packageRegistry.findUnique.mockResolvedValueOnce(
        row({ ecosystem: entry.ecosystem }) as never
      );
      const cleared = await app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { npmScopes: [] },
        url: `${BASE}/${ID}`,
      });
      expect(cleared.statusCode).toBe(200);
    });

    it(`lets an npm default and a ${entry.noun} default of one team coexist`, async () => {
      const teamId = '22222222-2222-4222-8222-222222222222';
      // The clash query is ecosystem-filtered, so the npm default is never returned for this candidate.
      prisma.packageRegistry.findMany.mockImplementation((async (a: {
        where: { ecosystem: string };
      }) => (a.where.ecosystem === 'npm' ? [row({ teamId })] : [])) as never);
      try {
        const scoped = await post({ teamId });
        expect(scoped.statusCode).toBe(201);
        const npm = await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { name: 'second-npm', teamId, upstreamUrl: 'https://registry.npmjs.org' },
          url: BASE,
        });
        expect(npm.statusCode).toBe(409);
        prisma.packageRegistry.findMany.mockImplementation((async (a: {
          where: { ecosystem: string };
        }) =>
          a.where.ecosystem === entry.ecosystem
            ? [row({ ecosystem: entry.ecosystem, teamId })]
            : []) as never);
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

    it(`rejects a second ${entry.noun} default for one team with 409`, async () => {
      prisma.packageRegistry.findMany.mockResolvedValueOnce([
        row({ ecosystem: entry.ecosystem, name: `first-${entry.ecosystem}` }),
      ] as never);
      const res = await post({ name: `second-${entry.ecosystem}` });
      expect(res.statusCode).toBe(409);
      const err = JSON.parse(res.payload).error;
      expect(err.code).toBe('PACKAGE_REGISTRY_CLASH');
      expect(err.message).toContain(`default ${entry.noun} registry`);
    });

    it(`lets a global ${entry.noun} default and a team ${entry.noun} default coexist`, async () => {
      const teamId = '22222222-2222-4222-8222-222222222222';
      // The team query is scoped to that team, so the global row is not returned.
      prisma.packageRegistry.findMany.mockResolvedValueOnce([] as never);
      const res = await post({ name: `team-${entry.ecosystem}`, teamId });
      expect(res.statusCode).toBe(201);
      expect(lastWhere()).toMatchObject({ ecosystem: entry.ecosystem, teamId });
    });

    it.each([
      ['credentials', entry.upstreamUrl.replace('https://', 'https://user:pw@')],
      ['a query string', `${entry.upstreamUrl}?x=1`],
      ['a fragment', `${entry.upstreamUrl}/#frag`],
    ])('refuses a URL with %s', async (_label, upstreamUrl) => {
      const res = await post({ upstreamUrl });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('BASE_URL_REFUSED');
    });

    it('refuses the same URL shapes on a PATCH', async () => {
      prisma.packageRegistry.findUnique.mockResolvedValueOnce(
        row({ ecosystem: entry.ecosystem }) as never
      );
      const res = await app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { upstreamUrl: `${entry.upstreamUrl}/?x=1` },
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('BASE_URL_REFUSED');
    });

    it('cannot change the ecosystem through PATCH', async () => {
      prisma.packageRegistry.update.mockClear();
      const res = await app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { ecosystem: entry.ecosystem, name: 'renamed' },
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

  describe('Maven registries serve open mode only', () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        headers: AUTH,
        method: 'POST',
        payload: {
          ecosystem: 'maven',
          name: 'maven-proxy',
          upstreamUrl: 'https://repo.maven.apache.org/maven2',
          ...payload,
        },
        url: BASE,
      });

    it('defaults an omitted accessMode to open', async () => {
      prisma.packageRegistry.create.mockClear();
      const res = await post({});
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.payload).data.accessMode).toBe('open');
      const audit = (prisma.configAuditLog.create.mock.calls.at(-1) as unknown as [unknown])[0] as {
        data: { afterJson: { accessMode: string } };
      };
      expect(audit.data.afterJson.accessMode).toBe('open');
    });

    it('accepts an explicit open', async () => {
      expect((await post({ accessMode: 'open' })).statusCode).toBe(201);
    });

    it('refuses lockfile on create', async () => {
      prisma.packageRegistry.create.mockClear();
      const res = await post({ accessMode: 'lockfile' });
      expect(res.statusCode).toBe(400);
      const err = JSON.parse(res.payload).error;
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toBe('a Maven registry serves open mode only');
      expect(prisma.packageRegistry.create).not.toHaveBeenCalled();
    });

    it('refuses lockfile on PATCH, by the stored ecosystem', async () => {
      prisma.packageRegistry.update.mockClear();
      prisma.packageRegistry.findUnique.mockResolvedValueOnce(
        row({ accessMode: 'open', ecosystem: 'maven' }) as never
      );
      const res = await app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { accessMode: 'lockfile' },
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR');
      expect(prisma.packageRegistry.update).not.toHaveBeenCalled();
    });

    it('still lets a PATCH send open', async () => {
      prisma.packageRegistry.findUnique.mockResolvedValueOnce(
        row({ accessMode: 'open', ecosystem: 'maven' }) as never
      );
      const res = await app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { accessMode: 'open' },
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(200);
    });

    it('leaves the lockfile default and lockfile PATCH alone for the other ecosystems', async () => {
      for (const [ecosystem, upstreamUrl] of [
        ['npm', 'https://registry.npmjs.org'],
        ['go', 'https://proxy.golang.org'],
        ['pypi', 'https://pypi.org/simple'],
      ]) {
        const created = await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { ecosystem, name: `${ecosystem}-default`, upstreamUrl },
          url: BASE,
        });
        expect(JSON.parse(created.payload).data.accessMode).toBe('lockfile');
        prisma.packageRegistry.findUnique.mockResolvedValueOnce(row({ ecosystem }) as never);
        const patched = await app.inject({
          headers: AUTH,
          method: 'PATCH',
          payload: { accessMode: 'lockfile' },
          url: `${BASE}/${ID}`,
        });
        expect(patched.statusCode).toBe(200);
      }
    });
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
