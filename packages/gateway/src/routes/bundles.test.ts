vi.mock('@auto-swe/shared/db', () => ({
  PrismaClient: vi.fn(),
  prisma: {},
}));

const { fetchBundleJsonMock } = vi.hoisted(() => ({ fetchBundleJsonMock: vi.fn() }));
vi.mock('../lib/bundleFetch.js', () => ({ fetchBundleJson: fetchBundleJsonMock }));

import {
  BUNDLE_SCHEMA_VERSION,
  type BundleEntities,
  computeContentHash,
} from '@auto-swe/shared/bundle';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillChangedError } from '../lib/bundleService.js';
import { bundleRoutes } from './bundles.js';

function newMockPrisma() {
  const client = {
    // installBundle wraps its writes in a transaction; hand the callback this mock.
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(client)),
    agent: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    installedBundle: {
      findMany: vi.fn().mockResolvedValue([
        {
          createdAt: new Date(),
          name: 'swe',
          signedBy: null,
          source: 'swe-starter',
          trustState: 'UNVERIFIED',
          updatedAt: new Date(),
          version: '1.0.0',
        },
      ]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: '99999999-9999-4999-8999-999999999999' }),
    },
    scannerPattern: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    skill: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    workflowTemplate: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  return client;
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', newMockPrisma() as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(bundleRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return app;
}

const AUTH = { authorization: 'Bearer fake' };

beforeEach(() => vi.clearAllMocks());
beforeAll(() => vi.stubEnv('BUNDLE_ALLOW_UNVERIFIED', '1'));
afterAll(() => vi.unstubAllEnvs());

describe('bundleRoutes', () => {
  it('exports an (empty) bundle for an admin', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { name: 'swe', version: '1.0.0' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/export',
    });
    expect(res.statusCode).toBe(200);
    const m = JSON.parse(res.payload).data;
    expect(m.bundleSchemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(m.metadata.name).toBe('swe');
    await app.close();
  });

  it('lists installed bundles for an admin', async () => {
    const app = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/platform/bundles' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toHaveLength(1);
    await app.close();
  });

  it('rejects export for a non-admin', async () => {
    const app = await buildApp('ENGINEER');
    const res = await app.inject({
      body: { name: 'swe', version: '1' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/export',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('400s on installing a malformed bundle', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { bundle: { not: 'a bundle' } },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/install',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_BUNDLE');
    await app.close();
  });

  it('400s on a content-hash mismatch', async () => {
    const app = await buildApp();
    const bundle = {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [],
      entities: { agents: [], scannerPatterns: [], skills: [], templates: [] },
      metadata: { contentHash: 'tampered', createdAt: 'now', name: 'n', version: '1' },
    };
    const res = await app.inject({
      body: { bundle },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/install',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s on a bundle carrying an uncompilable scanner pattern', async () => {
    // Compile / flags / length only. Bundle validation makes no execution-cost
    // claim — a catastrophic pattern installs and is bounded (and quarantined)
    // at run time by the scanners' wall-clock budget instead.
    const app = await buildApp();
    const entities = {
      agents: [],
      scannerPatterns: [{ flags: 'i', label: 'evil', pattern: '(unclosed', type: 'INJECTION' }],
      skills: [],
      templates: [],
    } as unknown as BundleEntities;
    const metadata = { createdAt: 'now', name: 'n', version: '1' };
    const bundle = {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [],
      entities,
      metadata: {
        ...metadata,
        contentHash: computeContentHash({
          bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
          dependencies: [],
          entities,
          metadata,
        }),
      },
    };
    const res = await app.inject({
      body: { bundle },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/install',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('INVALID_BUNDLE');
    expect(body.error.message).toMatch(/INVALID_REGEX/);
    await app.close();
  });

  it('400s on a bundle built under the old (v1) trust format', async () => {
    // Regression test: installBundle's parseBundle throws BundleSchemaVersionError
    // for this shape, which bundleService must catch and rewrap as
    // BundleIntegrityError. The route only maps BundleIntegrityError /
    // BundleDependencyError / ZodError to 400 — an unwrapped
    // BundleSchemaVersionError falls through to a generic 500.
    const app = await buildApp();
    const entities = { agents: [], scannerPatterns: [], skills: [], templates: [] };
    const bundle = {
      bundleSchemaVersion: 1,
      dependencies: [],
      entities,
      metadata: { contentHash: 'irrelevant', createdAt: 'now', name: 'n', version: '1' },
    };
    const res = await app.inject({
      body: { bundle },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/install',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_BUNDLE');
    await app.close();
  });

  it('installs a valid empty bundle', async () => {
    const app = await buildApp();
    const entities = { agents: [], scannerPatterns: [], skills: [], templates: [] };
    const metadata = { createdAt: 'now', name: 'n', version: '1' };
    const bundle = {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [],
      entities,
      metadata: {
        ...metadata,
        contentHash: computeContentHash({
          bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
          dependencies: [],
          entities,
          metadata,
        }),
      },
    };
    const res = await app.inject({
      body: { bundle },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/install',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.counts).toEqual({
      agents: 0,
      scannerPatterns: 0,
      skills: 0,
      templates: 0,
    });
    await app.close();
  });

  it('409s, not 500, when a skill was edited while the install ran', async () => {
    const app = await buildApp();
    const prisma = (app as unknown as { prisma: Record<string, unknown> }).prisma;
    prisma.$transaction = vi.fn().mockRejectedValue(new SkillChangedError('s'));
    const entities = { agents: [], scannerPatterns: [], skills: [], templates: [] };
    const metadata = { createdAt: 'now', name: 'n', version: '1' };
    const bundle = {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [],
      entities,
      metadata: {
        ...metadata,
        contentHash: computeContentHash({
          bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
          dependencies: [],
          entities,
          metadata,
        }),
      },
    };
    const res = await app.inject({
      body: { bundle },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/install',
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error.code).toBe('SKILL_CHANGED');
    await app.close();
  });

  it('does not read an unrelated unique-constraint failure as SKILL_CHANGED', async () => {
    const app = await buildApp();
    const prisma = (app as unknown as { prisma: Record<string, unknown> }).prisma;
    prisma.$transaction = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('x'), { code: 'P2002' }));
    const entities = { agents: [], scannerPatterns: [], skills: [], templates: [] };
    const metadata = { createdAt: 'now', name: 'n', version: '1' };
    const bundle = {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [],
      entities,
      metadata: {
        ...metadata,
        contentHash: computeContentHash({
          bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
          dependencies: [],
          entities,
          metadata,
        }),
      },
    };
    const res = await app.inject({
      body: { bundle },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/install',
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it('409s when a bundle agent would overwrite a built-in, unless overwriteProtected', async () => {
    const app = await buildApp();
    const prisma = (app as unknown as { prisma: Record<string, Record<string, unknown>> }).prisma;
    prisma.agent.findFirst = vi.fn().mockResolvedValue({ id: 'builtin', origin: 'swe-starter' });
    prisma.agent.update = vi.fn().mockResolvedValue({ id: 'builtin' });
    prisma.agentSkillRef = { deleteMany: vi.fn() };
    const entities = {
      agents: [{ key: 'reviewer', name: 'Reviewer' }],
      scannerPatterns: [],
      skills: [],
      templates: [],
    } as unknown as BundleEntities;
    const metadata = { createdAt: 'now', name: 'n', version: '1' };
    const bundle = {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [],
      entities,
      metadata: {
        ...metadata,
        contentHash: computeContentHash({
          bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
          dependencies: [],
          entities,
          metadata,
        }),
      },
    };

    const refused = await app.inject({
      body: { bundle },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/install',
    });
    expect(refused.statusCode).toBe(409);
    const refusal = JSON.parse(refused.payload).error;
    expect(refusal.code).toBe('PROTECTED_CONTENT_OVERWRITE');
    expect(refusal.conflicts).toEqual({
      agents: ['reviewer'],
      scannerPatterns: [],
      skills: [],
      templates: [],
    });
    expect(prisma.agent.update).not.toHaveBeenCalled();
    // The refusal is audited, against a uuid entity id (the column is uuid).
    const audit = prisma.configAuditLog.create as ReturnType<typeof vi.fn>;
    expect(audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterJson: expect.objectContaining({
          bundleName: 'n',
          outcome: 'refused',
          reason: 'protected-overwrite',
        }),
        entityId: '00000000-0000-0000-0000-000000000000',
        entityType: 'Bundle',
      }),
    });
    audit.mockClear();

    const forced = await app.inject({
      body: { bundle, overwriteProtected: true },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/install',
    });
    expect(forced.statusCode).toBe(200);
    expect(prisma.agent.update).toHaveBeenCalledTimes(1);
    // A forced install records what it replaced, keyed to the registry row.
    expect(audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterJson: expect.objectContaining({
          overwriteProtected: true,
          replacedProtected: {
            agents: ['reviewer'],
            scannerPatterns: [],
            skills: [],
            templates: [],
          },
        }),
        entityId: '99999999-9999-4999-8999-999999999999',
      }),
    });
    await app.close();
  });
});

function bundleWithAgent() {
  const entities = {
    agents: [{ key: 'reviewer', name: 'Reviewer' }],
    scannerPatterns: [],
    skills: [],
    templates: [],
  } as unknown as BundleEntities;
  const metadata = { createdAt: 'now', name: 'n', version: '2' };
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    dependencies: [],
    entities,
    metadata: {
      ...metadata,
      contentHash: computeContentHash({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        dependencies: [],
        entities,
        metadata,
      }),
    },
  };
}

describe('bundle preview', () => {
  it('reports what would be replaced, flags protected rows, and writes nothing', async () => {
    const app = await buildApp();
    const prisma = (app as unknown as { prisma: Record<string, Record<string, unknown>> }).prisma;
    prisma.agent.findFirst = vi.fn().mockResolvedValue({ id: 'builtin', origin: 'swe-starter' });
    prisma.installedBundle.findUnique = vi.fn().mockResolvedValue({ version: '1' });
    const res = await app.inject({
      body: { bundle: bundleWithAgent() },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/preview',
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data.trustState).toBe('UNVERIFIED');
    expect(data.installedVersion).toBe('1');
    expect(data.blockedReason).toBeNull();
    expect(data.entities.agents).toEqual([
      { action: 'replace', name: 'reviewer', protected: true },
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.installedBundle.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it('says so when this deployment refuses unverified bundles', async () => {
    vi.stubEnv('BUNDLE_ALLOW_UNVERIFIED', '0');
    const app = await buildApp();
    const res = await app.inject({
      body: { bundle: bundleWithAgent() },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/preview',
    });
    vi.stubEnv('BUNDLE_ALLOW_UNVERIFIED', '1');
    expect(JSON.parse(res.payload).data.blockedReason).toContain('unverified');
    await app.close();
  });

  it('400s on a tampered bundle and when neither bundle nor url is sent', async () => {
    const app = await buildApp();
    const tampered = bundleWithAgent();
    tampered.metadata.version = '3';
    const bad = await app.inject({
      body: { bundle: tampered },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/preview',
    });
    expect(bad.statusCode).toBe(400);
    const empty = await app.inject({
      body: {},
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/preview',
    });
    expect(empty.statusCode).toBe(400);
    await app.close();
  });

  it('refuses an install from a URL whose content changed since the preview', async () => {
    fetchBundleJsonMock.mockResolvedValueOnce(bundleWithAgent());
    const app = await buildApp();
    const res = await app.inject({
      body: { expectedContentHash: 'sha256:something-else', url: 'https://example.com/b.json' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/install-from-url',
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error.code).toBe('BUNDLE_CHANGED');
    await app.close();
  });

  describe('install from an uploaded file', () => {
    const post = (app: Awaited<ReturnType<typeof buildApp>>, body: unknown) =>
      app.inject({
        body: body as Record<string, unknown>,
        headers: AUTH,
        method: 'POST',
        url: '/api/v1/platform/bundles/install',
      });

    it('installs when the previewed content hash matches', async () => {
      const app = await buildApp();
      const prisma = (app as unknown as { prisma: Record<string, Record<string, unknown>> }).prisma;
      prisma.agent.create = vi.fn().mockResolvedValue({ id: 'new' });
      prisma.agentSkillRef = { deleteMany: vi.fn() };
      const bundle = bundleWithAgent();
      const res = await post(app, { bundle, expectedContentHash: bundle.metadata.contentHash });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data.counts.agents).toBe(1);
      await app.close();
    });

    it('409s and installs nothing when the bundle differs from the previewed one', async () => {
      const app = await buildApp();
      const prisma = (app as unknown as { prisma: Record<string, Record<string, unknown>> }).prisma;
      const res = await post(app, {
        bundle: bundleWithAgent(),
        expectedContentHash: 'sha256:something-else',
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('BUNDLE_CHANGED');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      await app.close();
    });

    it('refuses an unverified bundle when the deployment disallows them', async () => {
      vi.stubEnv('BUNDLE_ALLOW_UNVERIFIED', '0');
      const app = await buildApp();
      const bundle = bundleWithAgent();
      const res = await post(app, { bundle, expectedContentHash: bundle.metadata.contentHash });
      vi.stubEnv('BUNDLE_ALLOW_UNVERIFIED', '1');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('INVALID_BUNDLE');
      await app.close();
    });

    it('409s on replacing protected content without the confirmation flag', async () => {
      const app = await buildApp();
      const prisma = (app as unknown as { prisma: Record<string, Record<string, unknown>> }).prisma;
      prisma.agent.findFirst = vi.fn().mockResolvedValue({ id: 'builtin', origin: 'swe-starter' });
      prisma.agent.update = vi.fn().mockResolvedValue({ id: 'builtin' });
      prisma.agentSkillRef = { deleteMany: vi.fn() };
      const bundle = bundleWithAgent();
      const refused = await post(app, { bundle, expectedContentHash: bundle.metadata.contentHash });
      expect(refused.statusCode).toBe(409);
      expect(JSON.parse(refused.payload).error.code).toBe('PROTECTED_CONTENT_OVERWRITE');
      const forced = await post(app, {
        bundle,
        expectedContentHash: bundle.metadata.contentHash,
        overwriteProtected: true,
      });
      expect(forced.statusCode).toBe(200);
      await app.close();
    });

    it('rejects a body over the bundle size cap', async () => {
      vi.stubEnv('BUNDLE_MAX_BYTES', '1000');
      const app = await buildApp();
      const res = await post(app, { bundle: { filler: 'x'.repeat(100_000) } });
      vi.unstubAllEnvs();
      vi.stubEnv('BUNDLE_ALLOW_UNVERIFIED', '1');
      expect(res.statusCode).toBe(413);
      await app.close();
    });
  });

  it('is admin only', async () => {
    const app = await buildApp('ENGINEER');
    const res = await app.inject({
      body: { bundle: bundleWithAgent() },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/bundles/preview',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
