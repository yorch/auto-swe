vi.mock('@auto-swe/shared/db', () => ({
  PrismaClient: vi.fn(),
  prisma: {},
}));

import {
  BUNDLE_SCHEMA_VERSION,
  type BundleEntities,
  computeContentHash,
} from '@auto-swe/shared/bundle';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleRoutes } from './bundles.js';

function newMockPrisma() {
  const client = {
    // installBundle wraps its writes in a transaction; hand the callback this mock.
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(client)),
    agent: { findMany: vi.fn().mockResolvedValue([]) },
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
      upsert: vi.fn().mockResolvedValue({}),
    },
    scannerPattern: { findMany: vi.fn().mockResolvedValue([]) },
    skill: { findMany: vi.fn().mockResolvedValue([]) },
    workflowTemplate: { findMany: vi.fn().mockResolvedValue([]) },
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
  await app.register(bundleRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  return app;
}

const AUTH = { authorization: 'Bearer fake' };

beforeEach(() => vi.clearAllMocks());

describe('bundleRoutes', () => {
  it('exports an (empty) bundle for an admin', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { name: 'swe', version: '1.0.0' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/bundles/export',
    });
    expect(res.statusCode).toBe(200);
    const m = JSON.parse(res.payload).data;
    expect(m.bundleSchemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(m.metadata.name).toBe('swe');
    await app.close();
  });

  it('lists installed bundles for an admin', async () => {
    const app = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/admin/bundles' });
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
      url: '/api/v1/admin/bundles/export',
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
      url: '/api/v1/admin/bundles/install',
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
      url: '/api/v1/admin/bundles/install',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s on a bundle carrying a catastrophic scanner pattern', async () => {
    const app = await buildApp();
    const entities = {
      agents: [],
      scannerPatterns: [{ flags: 'i', label: 'evil', pattern: '(a+)+$', type: 'INJECTION' }],
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
      url: '/api/v1/admin/bundles/install',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('INVALID_BUNDLE');
    expect(body.error.message).toMatch(/REDOS_RISK/);
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
      url: '/api/v1/admin/bundles/install',
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
      url: '/api/v1/admin/bundles/install',
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
});
