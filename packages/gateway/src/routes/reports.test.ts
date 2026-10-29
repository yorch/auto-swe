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
    workflowStep: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
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

  it('keeps non-admin run visibility on delivery, quality, and HITL reads', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    for (const tab of ['delivery', 'quality', 'hitl']) {
      const response = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/reports/${tab}?window=30`,
      });
      expect(response.statusCode).toBe(200);
    }

    for (const [args] of prisma.workflowRun.findMany.mock.calls) {
      expect(args.where.AND).toContainEqual(
        expect.objectContaining({
          OR: expect.arrayContaining([{ workRequest: { requestedById: 'user-1' } }]),
        })
      );
    }
    for (const [args] of prisma.workflowHumanStep.findMany.mock.calls) {
      expect(args.where.run.OR).toContainEqual({
        workRequest: { requestedById: 'user-1' },
      });
    }
  });

  it('scopes automation fires before looking up produced-run status by their exact ids', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.automation.findMany.mockResolvedValue([
      { connectionId: 'connection-1', id: 'automation-1', teamId: null },
    ]);
    prisma.automationFire.findMany.mockResolvedValue([
      {
        automation: { enabled: true, name: 'Triage' },
        automationId: 'automation-1',
        createdAt: new Date(),
        outcome: 'STARTED',
        reason: null,
        temporalWorkflowId: 'workflow-1',
      },
    ]);
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/automations?window=30',
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.automation.findMany.mock.calls[0]?.[0].where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connection: expect.any(Object) }),
        {
          connectionId: null,
          team: { memberships: { some: { userId: 'user-1' } } },
        },
      ])
    );
    expect(prisma.automationFire.findMany.mock.calls[0]?.[0].where).toMatchObject({
      automationId: { in: ['automation-1'] },
    });
    expect(prisma.workflowRun.findMany.mock.calls[0]?.[0]).toMatchObject({
      select: { status: true, workflowId: true },
      where: { workflowId: { in: ['workflow-1'] } },
    });
    expect(response.json().data).toMatchObject({
      automationsTruncated: false,
      firesTruncated: false,
      producedRunsTruncated: false,
      truncated: false,
    });
  });

  it('uses the delivery attribution guard and one run-cost fallback across its slices', async () => {
    const { app, prisma } = await buildApp();
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const repoId = '00000000-0000-4000-8000-000000000001';
    const otherRepoId = '00000000-0000-4000-8000-000000000002';
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        costUsdAccrued: 0,
        id: 'run-1',
        startedAt,
        status: 'SUCCESS',
        template: { name: 'Build' },
        templateId: 'template-1',
        workflowId: 'workflow-1',
      },
    ]);
    prisma.activeWorkflow.findMany.mockResolvedValue([
      {
        costUsdAccrued: 5,
        repoId,
        repository: { organizationName: 'acme', repoName: 'api' },
        temporalWorkflowId: 'workflow-1',
      },
    ]);
    prisma.pullRequest.findMany.mockResolvedValue([
      {
        ciStatus: 'PASSED',
        mergedAt: new Date('2026-01-02T00:00:00.000Z'),
        repoId: otherRepoId,
        workflow: { repoId, temporalWorkflowId: 'workflow-1' },
      },
      {
        ciStatus: 'PASSED',
        mergedAt: new Date('2026-01-03T00:00:00.000Z'),
        repoId,
        workflow: { repoId, temporalWorkflowId: 'workflow-1' },
      },
    ]);
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/delivery?window=30',
    });
    const report = response.json().data;

    expect(response.statusCode).toBe(200);
    expect(report).toMatchObject({
      byRepo: [{ spendUsd: 5 }],
      byTemplate: [{ spendUsd: 5 }],
      costPerMergedPr: 5,
      prsMerged: 1,
      spendUsd: 5,
    });
    expect(prisma.pullRequest.findMany.mock.calls[0]?.[0].where).toEqual({
      workflow: { temporalWorkflowId: { in: ['workflow-1'] } },
    });
  });

  it('reports each bounded quality source truncation flag', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        id: 'run-1',
        startedAt: new Date(),
        template: { name: 'Build' },
        templateId: 'template-1',
        workflowId: 'workflow-1',
      },
    ]);
    const cappedRows = Array.from({ length: 10_001 }, () => ({
      ciStatus: 'PENDING',
      mergedAt: null,
      repoId: 'repo-1',
      workflow: null,
    }));
    prisma.pullRequest.findMany.mockResolvedValue(cappedRows);
    prisma.agentTrace.findMany.mockResolvedValue(
      Array.from({ length: 10_001 }, () => ({
        error: null,
        outputJson: { activityId: 'not-a-verdict' },
        runId: 'run-1',
      }))
    );

    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/quality?window=30',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      prsTruncated: true,
      runsTruncated: false,
      tracesTruncated: true,
      truncated: true,
    });
  });

  it('reports automation and HITL source truncation flags', async () => {
    const automationApp = await buildApp('ENGINEER');
    automationApp.prisma.automation.findMany.mockResolvedValue(
      Array.from({ length: 10_001 }, (_, index) => ({
        connectionId: 'connection-1',
        id: `automation-${index}`,
        teamId: null,
      }))
    );
    const automationResponse = await automationApp.app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/automations?window=30',
    });
    expect(automationResponse.json().data).toMatchObject({
      automationsTruncated: true,
      firesTruncated: false,
      producedRunsTruncated: false,
      truncated: true,
    });

    const hitlApp = await buildApp();
    const pendingStep = {
      kind: 'PR',
      requestedAt: new Date(),
      resolvedAt: null,
      resolvedBy: null,
      resolvedByUser: null,
      status: 'PENDING',
    };
    hitlApp.prisma.workflowHumanStep.findMany
      .mockResolvedValueOnce(Array.from({ length: 10_001 }, () => pendingStep))
      .mockResolvedValueOnce([]);
    hitlApp.prisma.autonomyDecision.findMany.mockResolvedValue(
      Array.from({ length: 10_001 }, () => ({ event: 'ALLOW', riskClass: 'LOW' }))
    );
    const hitlResponse = await hitlApp.app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/hitl?window=30',
    });
    expect(hitlResponse.json().data).toMatchObject({
      decisionsTruncated: true,
      pendingStepsTruncated: false,
      truncated: true,
      windowStepsTruncated: true,
    });
  });
});
