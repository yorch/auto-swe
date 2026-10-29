import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { reportsRoutes } from './reports.js';

function mockPrisma() {
  return {
    activeWorkflow: { findMany: vi.fn().mockResolvedValue([]) },
    agentTrace: { findMany: vi.fn().mockResolvedValue([]) },
    automation: { findMany: vi.fn().mockResolvedValue([]) },
    automationFire: { findMany: vi.fn().mockResolvedValue([]) },
    autonomyDecision: { findMany: vi.fn().mockResolvedValue([]) },
    organization: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequest: { findMany: vi.fn().mockResolvedValue([]) },
    workflowHumanStep: { findMany: vi.fn().mockResolvedValue([]) },
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
    workflowStep: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

async function buildApp(role = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = mockPrisma();
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(reportsRoutes, { prefix: '/api/v1/reports' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };

describe('report routes', () => {
  it('serves empty report payloads for all five tabs', async () => {
    const { app } = await buildApp();
    for (const tab of ['delivery', 'quality', 'budget', 'automations', 'hitl']) {
      const response = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/reports/${tab}?window=30`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toBeTruthy();
      expect(response.json().data.truncated).toBe(false);
    }
  });

  it('restricts budget reads to organizations administered by the caller', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/budget',
    });
    expect(response.statusCode).toBe(403);
    expect(prisma.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { memberships: { some: { role: 'ORG_ADMIN', userId: 'user-1' } } },
      })
    );
  });

  it('requires an engineer-level role for delivery, quality, automation, and approval reports', async () => {
    const { app } = await buildApp('VIEWER');
    for (const tab of ['delivery', 'quality', 'automations', 'hitl']) {
      const response = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/reports/${tab}`,
      });
      expect(response.statusCode).toBe(403);
    }
  });
});
