import { BUNDLE_SCHEMA_VERSION, computeContentHash } from '@auto-swe/shared/bundle';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleRoutes } from './bundles.js';

function newMockPrisma() {
  return {
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    scannerPattern: { findMany: vi.fn().mockResolvedValue([]) },
    skill: { findMany: vi.fn().mockResolvedValue([]) },
    workflowTemplate: { findMany: vi.fn().mockResolvedValue([]) },
  };
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

  it('installs a valid empty bundle', async () => {
    const app = await buildApp();
    const entities = { agents: [], scannerPatterns: [], skills: [], templates: [] };
    const bundle = {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [],
      entities,
      metadata: {
        contentHash: computeContentHash({ dependencies: [], entities }),
        createdAt: 'now',
        name: 'n',
        version: '1',
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
