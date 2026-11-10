import { computeOutcomeReport } from '@auto-swe/shared/workflow';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { outcomeReportRoutes } from './outcomeReports.js';

const stored = computeOutcomeReport({
  generatedAt: new Date('2026-02-01T00:00:00Z'),
  pullRequests: [],
  runs: [],
  steps: [],
  window: { end: new Date('2026-02-01T00:00:00Z'), start: new Date('2025-11-03T00:00:00Z') },
});

vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  getArtifactText: vi.fn(async () => JSON.stringify(stored)),
}));

function mockPrisma(snapshot: { id: string } | null) {
  return {
    activeWorkflow: { findMany: vi.fn().mockResolvedValue([]) },
    agentTrace: { findMany: vi.fn().mockResolvedValue([]) },
    connection: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequest: { findMany: vi.fn().mockResolvedValue([]) },
    workflowArtifact: { findFirst: vi.fn().mockResolvedValue(snapshot) },
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
    workflowStep: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

async function buildApp(role: string, snapshot: { id: string } | null = { id: 'a1' }) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = mockPrisma(snapshot);
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(outcomeReportRoutes, { prefix: '/api/v1/reports/outcomes' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };

describe('outcome report routes', () => {
  it('refuses a non-admin on both routes', async () => {
    const { app } = await buildApp('ENGINEER');
    for (const url of ['/api/v1/reports/outcomes', '/api/v1/reports/outcomes/latest']) {
      const response = await app.inject({ headers: AUTH, method: 'GET', url });
      expect(response.statusCode).toBe(403);
    }
  });

  it('computes the report from run data on demand', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/outcomes?windowDays=30',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.overall.workItems).toBe(0);
    expect(prisma.workflowRun.findMany).toHaveBeenCalled();
  });

  it('renders Markdown on request', async () => {
    const { app } = await buildApp('ADMIN');
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/outcomes?format=markdown',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.body).toContain('# Outcome metrics');
  });

  it('serves the newest stored snapshot', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/outcomes/latest',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.generatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(prisma.workflowArtifact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kind: 'outcome-report', runId: null, status: 'ready' },
      })
    );
  });

  it('answers 404 with a hint when no snapshot exists yet', async () => {
    const { app } = await buildApp('ADMIN', null);
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/outcomes/latest',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain('OUTCOME_REPORT_ENABLED');
  });
});
