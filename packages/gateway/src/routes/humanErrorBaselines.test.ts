vi.mock('@auto-swe/shared/db', () => ({
  PrismaClient: vi.fn(),
  prisma: {},
}));

import { hasTenantPredicate, isUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { humanErrorBaselineRoutes } from './humanErrorBaselines.js';

const ORG = '11111111-1111-4111-8111-111111111111';

/**
 * Records, for each listing query, what the tenant guard would see: the
 * `where`, whether it scopes to a tenant, and whether the call ran inside an
 * explicit `runUnscoped`. A guarded query that neither scopes nor is unscoped
 * is exactly what `UnscopedTenantQueryError` refuses at run time — a 500.
 */
async function buildApp(role: 'ADMIN' | 'LEAD') {
  const seen: Array<{ where: unknown; scoped: boolean; unscoped: boolean }> = [];
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', {
    humanErrorBaseline: {
      findMany: vi.fn(async ({ where }: { where: unknown }) => {
        seen.push({
          scoped: hasTenantPredicate(where),
          unscoped: isUnscoped('HumanErrorBaseline'),
          where,
        });
        return [];
      }),
    },
  } as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(humanErrorBaselineRoutes, { prefix: '/api/v1/baselines' });
  await app.ready();
  return { app, seen };
}

const AUTH = { authorization: 'Bearer t' };

describe('GET /human-error-baselines', () => {
  it('lets an ADMIN list every org’s baselines with no orgId — explicitly unscoped, not a 500', async () => {
    const { app, seen } = await buildApp('ADMIN');
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/baselines' });
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    // No `orgId: undefined` masquerading as a filter.
    expect(seen[0]?.where).toEqual({});
    expect(seen[0]?.unscoped).toBe(true);
    await app.close();
  });

  it('scopes an ADMIN listing to the org asked for', async () => {
    const { app, seen } = await buildApp('ADMIN');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/baselines?orgId=${ORG}`,
    });
    expect(res.statusCode).toBe(200);
    expect(seen[0]?.where).toEqual({ orgId: ORG });
    await app.close();
  });

  it('keeps a LEAD behind org membership, with or without orgId, and never unscoped', async () => {
    const { app, seen } = await buildApp('LEAD');
    await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/baselines' });
    await app.inject({ headers: AUTH, method: 'GET', url: `/api/v1/baselines?orgId=${ORG}` });
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.scoped).toBe(true);
      expect(call.unscoped).toBe(false);
      expect(call.where).toMatchObject({
        organization: { memberships: { some: { userId: 'user-1' } } },
      });
    }
    expect(seen[0]?.where).not.toHaveProperty('orgId');
    expect(seen[1]?.where).toMatchObject({ orgId: ORG });
    await app.close();
  });
});
