import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { reportsRoutes } from './reports.js';

vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSetting: vi.fn(async () => true),
}));

function mockPrisma() {
  return {
    activeWorkflow: { findMany: vi.fn().mockResolvedValue([]) },
    agentTrace: { findMany: vi.fn().mockResolvedValue([]) },
    automation: { findMany: vi.fn().mockResolvedValue([]) },
    automationFire: { findMany: vi.fn().mockResolvedValue([]) },
    autonomyDecision: { findMany: vi.fn().mockResolvedValue([]) },
    connection: { findMany: vi.fn().mockResolvedValue([]) },
    humanStepDailyRollup: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    organization: { findMany: vi.fn().mockResolvedValue([]) },
    organizationMembership: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequest: { findMany: vi.fn().mockResolvedValue([]) },
    reviewVerdictDailyRollup: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    team: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    teamMembership: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    workflowHumanStep: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
    workflowRunDailyRollup: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    workflowStep: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    workflowTemplate: { findMany: vi.fn().mockResolvedValue([]) },
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
      expect(response.statusCode, response.body).toBe(200);
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

  it('uses attribution visibility for rollups and legacy visibility for non-rollup reads', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    const delivery = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/delivery?window=30',
    });
    expect(delivery.statusCode, delivery.body).toBe(200);
    const deliveryRunQuery = prisma.workflowRun.findMany.mock.calls[0]?.[0];
    expect(deliveryRunQuery?.where.AND).toContainEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          { attributedTeamId: { in: [] } },
          { attributedOrgId: { in: [] } },
          { launchedById: 'user-1' },
        ]),
      })
    );

    const qualityStart = prisma.workflowRun.findMany.mock.calls.length;
    const quality = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/quality?window=30',
    });
    expect(quality.statusCode, quality.body).toBe(200);
    const qualityRunQueries = prisma.workflowRun.findMany.mock.calls
      .slice(qualityStart)
      .map(([args]) => args);
    expect(qualityRunQueries[0]?.where.AND).toContainEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([{ launchedById: 'user-1' }]),
      })
    );
    expect(qualityRunQueries[1]?.where.AND).toContainEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([{ launchedById: 'user-1' }]),
      })
    );

    const hitl = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/hitl?window=30',
    });
    expect(hitl.statusCode, hitl.body).toBe(200);
    for (const [args] of prisma.workflowHumanStep.findMany.mock.calls) {
      expect(JSON.stringify(args.where)).toContain('"launchedById":"user-1"');
    }
  });

  it('authorizes team filters for members and matching org admins only', async () => {
    const teamId = '00000000-0000-4000-8000-000000000001';
    const memberApp = await buildApp('ENGINEER');
    memberApp.prisma.teamMembership.findMany.mockResolvedValue([{ teamId }]);
    const memberResponse = await memberApp.app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/reports/delivery?teamId=${teamId}`,
    });
    expect(memberResponse.statusCode).toBe(200);
    expect(memberApp.prisma.workflowRun.findMany.mock.calls[0]?.[0].where.AND).toContainEqual({
      attributedTeamId: teamId,
    });
    const memberHitlResponse = await memberApp.app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/reports/hitl?teamId=${teamId}`,
    });
    expect(memberHitlResponse.statusCode).toBe(200);
    expect(
      JSON.stringify(memberApp.prisma.workflowHumanStep.findMany.mock.calls[0]?.[0].where)
    ).toContain(`"attributedTeamId":"${teamId}"`);

    const matchingOrgAdmin = await buildApp('ENGINEER');
    matchingOrgAdmin.prisma.organizationMembership.findMany.mockResolvedValue([{ orgId: 'org-1' }]);
    matchingOrgAdmin.prisma.team.findUnique.mockResolvedValue({ orgId: 'org-1' });
    const authorizedResponse = await matchingOrgAdmin.app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/reports/delivery?teamId=${teamId}`,
    });
    expect(authorizedResponse.statusCode).toBe(200);
    expect(
      matchingOrgAdmin.prisma.workflowRun.findMany.mock.calls[0]?.[0].where.AND
    ).toContainEqual({ attributedTeamId: teamId });

    const otherOrgAdmin = await buildApp('ENGINEER');
    otherOrgAdmin.prisma.organizationMembership.findMany.mockResolvedValue([{ orgId: 'org-1' }]);
    otherOrgAdmin.prisma.team.findUnique.mockResolvedValue({ orgId: 'org-2' });
    const forbiddenResponse = await otherOrgAdmin.app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/reports/delivery?teamId=${teamId}`,
    });
    expect(forbiddenResponse.statusCode).toBe(403);

    const unauthorizedMember = await buildApp('ENGINEER');
    unauthorizedMember.prisma.team.findUnique.mockResolvedValue({ orgId: 'org-2' });
    const memberForbidden = await unauthorizedMember.app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/reports/delivery?teamId=${teamId}`,
    });
    expect(memberForbidden.statusCode).toBe(403);
  });

  it('uses the new attribution scope for live HITL reads', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    for (const tab of ['quality', 'hitl']) {
      const response = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/reports/${tab}?window=30`,
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    for (const [args] of prisma.workflowHumanStep.findMany.mock.calls) {
      expect(JSON.stringify(args.where)).toContain('"launchedById":"user-1"');
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

    expect(response.statusCode, response.body).toBe(200);
    expect(prisma.automation.findMany.mock.calls[0]?.[0].where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ connection: expect.any(Object) }),
            {
              connectionId: null,
              team: { memberships: { some: { userId: 'user-1' } } },
            },
          ]),
        }),
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
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        attributedOrgId: null,
        attributedTeamId: null,
        costUsdAccrued: 0,
        endedAt: new Date('2026-01-01T01:00:00.000Z'),
        estimatedHumanTimeSaved: null,
        hadHumanStep: null,
        id: 'run-1',
        outcomeDomain: null,
        outcomeType: null,
        startedAt,
        status: 'SUCCESS',
        templateId: 'template-1',
        templateVersion: 1,
        wasAutonomous: null,
        workflowId: 'workflow-1',
        workRequest: {
          activeWorkflows: [
            {
              costUsdAccrued: 5,
              repoId,
              temporalWorkflowId: 'workflow-1',
            },
          ],
        },
      },
    ]);
    prisma.pullRequest.findMany.mockResolvedValue([
      {
        ciStatus: 'PASSED',
        mergedAt: new Date('2026-01-02T00:00:00.000Z'),
        runId: null,
        status: 'MERGED',
      },
      {
        ciStatus: 'PASSED',
        mergedAt: new Date('2026-01-03T00:00:00.000Z'),
        runId: 'run-1',
        status: 'MERGED',
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
      runId: { in: ['run-1'] },
    });
  });

  it('masks a hidden template on a run visible only through its repository', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    const repoId = '00000000-0000-4000-8000-000000000001';
    prisma.connection.findMany.mockResolvedValue([
      { id: repoId, organizationName: 'acme', repoName: 'private-repo' },
    ] as never);
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        attributedOrgId: null,
        attributedRepoId: repoId,
        attributedTeamId: null,
        costUsdAccrued: 0,
        endedAt: null,
        estimatedHumanTimeSaved: null,
        hadHumanStep: null,
        hasError: false,
        id: 'repo-visible-run',
        launchedById: null,
        outcomeDomain: null,
        outcomeType: null,
        startedAt: new Date(),
        status: 'SUCCESS',
        templateId: 'hidden-template',
        templateVersion: 1,
        wasAutonomous: null,
        workflowId: 'repo-visible-workflow',
        workRequest: { activeWorkflows: [] },
      },
    ] as never);

    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/delivery?window=30',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.byTemplate).toMatchObject([{ templateName: 'Private template' }]);
    const runWhere = prisma.workflowRun.findMany.mock.calls[0]?.[0].where;
    expect(JSON.stringify(runWhere)).toContain(`"attributedRepoId":{"in":["${repoId}"]}`);
  });

  it('masks foreign teams and approvers on repo-visible runs', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    const repoId = '00000000-0000-4000-8000-000000000001';
    prisma.teamMembership.findMany.mockResolvedValue([{ teamId: 'own-team' }] as never);
    prisma.connection.findMany.mockResolvedValue([
      { id: repoId, organizationName: 'acme', repoName: 'shared-repo' },
    ] as never);
    prisma.team.findMany.mockResolvedValue([{ id: 'own-team', name: 'Own team' }] as never);
    const run = {
      attributedOrgId: null,
      attributedRepoId: repoId,
      attributedTeamId: 'foreign-team',
      costUsdAccrued: 0,
      endedAt: null,
      estimatedHumanTimeSaved: null,
      hadHumanStep: null,
      hasError: false,
      id: 'foreign-team-run',
      launchedById: null,
      outcomeDomain: null,
      outcomeType: null,
      startedAt: new Date(),
      status: 'SUCCESS',
      templateId: null,
      templateVersion: null,
      wasAutonomous: null,
      workflowId: 'foreign-team-workflow',
      workRequest: { activeWorkflows: [] },
    };
    prisma.workflowRun.findMany.mockResolvedValue([
      run,
      { ...run, attributedRepoId: null, attributedTeamId: 'own-team', id: 'own-team-run' },
    ] as never);
    prisma.workflowHumanStep.findMany.mockResolvedValueOnce([
      {
        kind: 'APPROVAL',
        requestedAt: new Date(),
        resolvedAt: new Date(),
        resolvedBy: 'foreign-approver',
        resolvedVia: 'web',
        status: 'RESOLVED',
      },
    ] as never);

    const delivery = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/delivery?window=30',
    });
    expect(delivery.statusCode, delivery.body).toBe(200);
    expect(delivery.json().data.byTeam).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ teamId: null, teamName: 'Other team' }),
        expect.objectContaining({ teamId: 'own-team', teamName: 'Own team' }),
      ])
    );
    expect(JSON.stringify(delivery.json().data.byTeam)).not.toContain('foreign-team');

    const hitl = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/hitl?window=30',
    });
    expect(hitl.statusCode, hitl.body).toBe(200);
    expect(hitl.json().data.byApprover).toMatchObject([{ name: 'Other approver' }]);
    expect(JSON.stringify(prisma.workflowHumanStep.findMany.mock.calls[0]?.[0].where)).toContain(
      `"attributedRepoId":{"in":["${repoId}"]}`
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                { memberships: { some: { teamId: { in: ['own-team'] } } } },
              ]),
            }),
          ]),
        }),
      })
    );
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

  it('cohorts live HITL steps by requestedAt and preserves exact live wait percentiles', async () => {
    const { app, prisma } = await buildApp();
    const requestedAt = new Date('2026-10-01T12:00:00.000Z');
    prisma.workflowHumanStep.findMany.mockResolvedValueOnce([
      {
        kind: 'APPROVAL',
        requestedAt,
        resolvedAt: new Date(requestedAt.getTime() + 1),
        resolvedBy: null,
        resolvedByUser: { name: null },
        resolvedVia: 'web',
        status: 'RESOLVED',
      },
      {
        kind: 'APPROVAL',
        requestedAt,
        resolvedAt: new Date(requestedAt.getTime() + 9),
        resolvedBy: null,
        resolvedByUser: { name: null },
        resolvedVia: 'web',
        status: 'RESOLVED',
      },
    ]);

    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/hitl?since=2026-10-01&until=2026-10-01',
    });

    expect(response.statusCode, response.body).toBe(200);
    const query = prisma.workflowHumanStep.findMany.mock.calls[0]?.[0];
    expect(query?.where.AND[0].requestedAt).toMatchObject({
      gte: new Date('2026-10-01T00:00:00.000Z'),
      lt: new Date('2026-10-02T00:00:00.000Z'),
    });
    expect(response.json().data).toMatchObject({
      medianWaitMs: 5,
      p95WaitMs: 9,
    });
  });

  it('selects live reviewer traces only from the review network node', async () => {
    const { app, prisma } = await buildApp();
    const startedAt = new Date('2026-10-01T12:00:00.000Z');
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        attributedOrgId: 'org-1',
        attributedTeamId: 'team-1',
        costUsdAccrued: 1,
        endedAt: new Date(startedAt.getTime() + 60_000),
        estimatedHumanTimeSaved: null,
        hadHumanStep: false,
        id: 'run-1',
        outcomeDomain: null,
        outcomeType: null,
        startedAt,
        status: 'SUCCESS',
        template: { name: 'Template' },
        templateId: 'template-1',
        templateVersion: 1,
        wasAutonomous: true,
        workflowId: 'workflow-1',
      },
    ]);
    prisma.agentTrace.findMany.mockResolvedValue([
      {
        error: null,
        outputJson: {
          approved: true,
          findings: [],
          reviewer: 'SECURITY',
          severity: 'INFO',
        },
        runId: 'run-1',
      },
    ]);

    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/reports/quality?since=2026-10-01&until=2026-10-01',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(prisma.agentTrace.findMany.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of prisma.agentTrace.findMany.mock.calls) {
      expect(args.where).toMatchObject({ nodeId: 'runReviewNetwork' });
    }
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
