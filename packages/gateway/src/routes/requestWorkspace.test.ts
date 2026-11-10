import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

// The instance's own host: a GHE-primary deployment, so github.com is wrong.
vi.mock('@auto-swe/shared/lib/systemConfig', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveGitHubBaseUrl: vi.fn(async () => 'https://ghe.corp'),
}));

import '../test/warmAuthImports.js';
import { requestWorkspaceRoutes } from './requestWorkspace.js';

const USER = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
async function build(role = 'ENGINEER') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    team: { findFirst: vi.fn().mockResolvedValue({ id: TEAM }) },
    workflowHumanStep: { findMany: vi.fn().mockResolvedValue([]) },
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
  };
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: USER }),
  } as never);
  await app.register(requestWorkspaceRoutes, { prefix: '/runs' });
  return { app, prisma };
}
const auth = { authorization: 'Bearer fake' };
const latest = [
  { _count: { humanSteps: 0 }, id: 'success', status: 'SUCCESS' },
  { _count: { humanSteps: 1 }, id: 'pending', status: 'RUNNING' },
  { _count: { humanSteps: 0 }, id: 'failed', status: 'FAILED' },
];

describe('request workspace', () => {
  it('filters latest attempts before pagination, preserving distinct request totals', async () => {
    const { app, prisma } = await build();
    prisma.workflowRun.findMany.mockResolvedValueOnce(latest).mockResolvedValueOnce([]);
    prisma.workflowHumanStep.findMany.mockResolvedValueOnce([{ id: 's1', runId: 'pending' }]);
    const response = await app.inject({
      headers: auth,
      url: '/runs/requests?state=attention&limit=1&offset=1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta).toEqual({ limit: 1, offset: 1, total: 2 });
    const first = prisma.workflowRun.findMany.mock.calls[0][0];
    expect(first.distinct).toEqual(['workRequestId', 'connectionId']);
    expect(first.orderBy).toEqual([{ startedAt: 'desc' }, { id: 'desc' }]);
    expect(first.where.status).toBeUndefined();
    expect(first.where.workRequest).toEqual({ requestedById: USER });
    expect(first.where.AND[0]).toHaveProperty('OR');
    expect(prisma.workflowRun.findMany.mock.calls[1][0].where.AND[1]).toEqual({
      id: { in: ['failed'] },
    });
    await app.close();
  });

  it('returns no failed requests when the latest attempt succeeded', async () => {
    const { app, prisma } = await build();
    prisma.workflowRun.findMany.mockResolvedValueOnce([latest[0]]);
    const response = await app.inject({ headers: auth, url: '/runs/requests?state=failed' });
    expect(response.json()).toEqual({ data: [], meta: { limit: 50, offset: 0, total: 0 } });
    expect(prisma.workflowRun.findMany).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('projects target and visible attempt count without leaking joined request fields', async () => {
    const { app, prisma } = await build();
    prisma.workflowRun.findMany.mockResolvedValueOnce([latest[0]]).mockResolvedValueOnce([
      {
        ...latest[0],
        endedAt: null,
        startedAt: new Date(),
        template: { name: 'Update deps', workspaceProvider: 'git_repo' },
        workflowId: 'wf-success',
        workRequest: {
          _count: { workflowRuns: 3 },
          activeWorkflows: [
            { repository: { name: null, organizationName: 'acme', repoName: 'api' } },
          ],
          connection: null,
          description: 'Update dependencies',
          externalTicketId: 'DEP-1',
          id: 'request',
        },
      },
    ]);
    const response = await app.inject({ headers: auth, url: '/runs/requests?search=dependencies' });
    const row = response.json().data[0];
    expect(row).toMatchObject({ attemptCount: 3, pendingStepCount: 0, target: 'acme/api' });
    expect(row.pendingStepDeadline).toBeNull();
    expect(row.workRequest).toEqual({
      description: 'Update dependencies',
      externalTicketId: 'DEP-1',
      id: 'request',
    });
    const projection = prisma.workflowRun.findMany.mock.calls[1][0];
    expect(projection.include.workRequest.select._count.select.workflowRuns.where).toHaveProperty(
      'OR'
    );
    expect(projection.include.workRequest.select.activeWorkflows.where).toHaveProperty(
      'repository'
    );
    await app.close();
  });

  it('names the owning team of each request, from one extra query over the page’s runs', async () => {
    const { app, prisma } = await build();
    const repo = (id: string, name: string, slug: string) => ({
      name: null,
      organizationName: 'acme',
      repoName: slug,
      shares: [{ teamId: 'sharee' }],
      team: { id, name, slug },
    });
    prisma.workflowRun.findMany
      .mockResolvedValueOnce([latest[0]])
      .mockResolvedValueOnce([
        {
          ...latest[0],
          endedAt: null,
          startedAt: new Date(),
          template: { name: 'Update deps', workspaceProvider: 'git_repo' },
          workflowId: 'wf-success',
          workRequest: {
            _count: { workflowRuns: 1 },
            activeWorkflows: [],
            connection: null,
            description: 'Update dependencies',
            externalTicketId: 'DEP-1',
            id: 'request',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          connection: repo('t-pay', 'Payments', 'payments'),
          id: 'success',
          template: { team: null },
          workflowId: 'wf-success',
          workRequest: { activeWorkflows: [], connection: null, isCrossRepo: true },
        },
      ]);
    const response = await app.inject({ headers: auth, url: '/runs/requests' });
    expect(response.statusCode).toBe(200);
    // The owner is named; the team the repository is shared with is not.
    expect(response.json().data[0].teams).toEqual([{ id: 't-pay', name: 'Payments' }]);
    const query = prisma.workflowRun.findMany.mock.calls[2][0];
    expect(query.where.AND[0]).toHaveProperty('OR');
    expect(query.where.AND[1]).toEqual({ id: { in: ['success'] } });
    await app.close();
  });

  it("links the review on the instance's host when the repository names none", async () => {
    const { app, prisma } = await build();
    prisma.workflowRun.findMany.mockResolvedValueOnce([latest[0]]).mockResolvedValueOnce([
      {
        ...latest[0],
        endedAt: null,
        humanSteps: [],
        startedAt: new Date(),
        template: { name: 'Update deps', workspaceProvider: 'git_repo' },
        workflowId: 'wf-success',
        workRequest: {
          _count: { workflowRuns: 1 },
          activeWorkflows: [
            {
              currentStatus: 'PR_OPEN',
              pullRequests: [{ prNumber: 4 }],
              repository: {
                githubUrl: null,
                name: null,
                organizationName: 'acme',
                repoName: 'api',
              },
              temporalWorkflowId: 'wf-success',
            },
          ],
          connection: null,
          description: 'Update dependencies',
          externalTicketId: 'DEP-1',
          id: 'request',
        },
      },
    ]);
    const response = await app.inject({ headers: auth, url: '/runs/requests' });
    expect(response.json().data[0].reviewUrl).toBe('https://ghe.corp/acme/api/pull/4');
    await app.close();
  });

  it('keeps team scope constrained by run visibility and rejects malformed queries', async () => {
    const { app, prisma } = await build();
    prisma.workflowRun.findMany.mockResolvedValue([]);
    const response = await app.inject({ headers: auth, url: '/runs/requests?scope=TEAM' });
    expect(response.statusCode).toBe(200);
    expect(prisma.workflowRun.findMany.mock.calls[0][0].where.AND[0]).toHaveProperty('OR');
    for (const query of ['scope=ALL', 'offset=-1', 'state=waiting']) {
      expect((await app.inject({ headers: auth, url: `/runs/requests?${query}` })).statusCode).toBe(
        400
      );
    }
    await app.close();
  });

  it('matches the description, ticket ID and launch label, ANDed with run visibility and the MINE scope', async () => {
    const { app, prisma } = await build();
    prisma.workflowRun.findMany.mockResolvedValue([]);
    const response = await app.inject({ headers: auth, url: '/runs/requests?search=JIRA-4077' });
    expect(response.statusCode).toBe(200);
    const where = prisma.workflowRun.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { workRequest: { description: { contains: 'JIRA-4077', mode: 'insensitive' } } },
      { workRequest: { externalTicketId: { contains: 'JIRA-4077', mode: 'insensitive' } } },
      { workRequest: { title: { contains: 'JIRA-4077', mode: 'insensitive' } } },
    ]);
    // Siblings of the search `OR`, so all of them must hold: the search only narrows.
    expect(where.AND[0]).toHaveProperty('OR');
    expect(where.workRequest).toEqual({ requestedById: USER });
    expect(where.template).toBeDefined();
    await app.close();
  });

  it('keeps team-scoped visibility when searching, and caps the query length', async () => {
    const { app, prisma } = await build();
    prisma.workflowRun.findMany.mockResolvedValue([]);
    await app.inject({ headers: auth, url: '/runs/requests?scope=TEAM&search=auth' });
    const where = prisma.workflowRun.findMany.mock.calls[0][0].where;
    expect(where.AND[0]).toHaveProperty('OR');
    expect(where.workRequest).toBeUndefined();
    expect(where.OR).toHaveLength(3);
    const long = await app.inject({
      headers: auth,
      url: `/runs/requests?search=${'a'.repeat(201)}`,
    });
    expect(long.statusCode).toBe(400);
    await app.close();
  });
});

describe('request workspace team scope and control', () => {
  const OR_TERMS = 4;

  it('puts the team scope in its own AND term beside visibility, so it only narrows', async () => {
    const { app, prisma } = await build();
    prisma.workflowRun.findMany.mockResolvedValueOnce([]);
    const response = await app.inject({ headers: auth, url: `/runs/requests?teamId=${TEAM}` });
    expect(response.statusCode).toBe(200);
    const where = prisma.workflowRun.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(2);
    // The visibility OR and the team OR are separate entries; neither can overwrite the other.
    expect(where.AND[0].OR.length).toBeGreaterThan(OR_TERMS);
    expect(where.AND[1].OR).toHaveLength(OR_TERMS);
    expect(where.AND[1].OR[0]).toEqual({
      connection: { OR: [{ teamId: TEAM }, { shares: { some: { teamId: TEAM } } }] },
    });
    expect(where.OR).toBeUndefined();
    await app.close();
  });

  it('answers 404 TEAM_NOT_FOUND for a non-member and reads no runs', async () => {
    const { app, prisma } = await build();
    prisma.team.findFirst.mockResolvedValue(null);
    const response = await app.inject({ headers: auth, url: `/runs/requests?teamId=${TEAM}` });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('TEAM_NOT_FOUND');
    expect(prisma.workflowRun.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it('lets a platform ADMIN scope to any team without a membership lookup', async () => {
    const { app, prisma } = await build('ADMIN');
    prisma.team.findFirst.mockResolvedValue(null);
    prisma.workflowRun.findMany.mockResolvedValueOnce([]);
    const response = await app.inject({ headers: auth, url: `/runs/requests?teamId=${TEAM}` });
    expect(response.statusCode).toBe(200);
    expect(prisma.team.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it('counts only steps the caller controls toward attention and pendingStepCount', async () => {
    const { app, prisma } = await build();
    // Two runs each show one visible pending step; the caller controls only the second.
    prisma.workflowRun.findMany.mockResolvedValueOnce([
      { _count: { humanSteps: 1 }, id: 'seen', status: 'SUCCESS', workflowId: 'a' },
      { _count: { humanSteps: 1 }, id: 'mine', status: 'SUCCESS', workflowId: 'b' },
    ]);
    prisma.workflowHumanStep.findMany.mockResolvedValueOnce([{ id: 's2', runId: 'mine' }]);
    prisma.workflowRun.findMany.mockResolvedValueOnce([]);
    const response = await app.inject({ headers: auth, url: '/runs/requests?state=attention' });
    expect(response.json().meta.total).toBe(1);
    const stepQuery = prisma.workflowHumanStep.findMany.mock.calls[0][0];
    expect(stepQuery.where.AND[1]).toEqual({ runId: { in: ['seen', 'mine'] } });
    // The same predicate as the approvals list and badge: control (never weakened to bare
    // visibility), no step the caller already approved, no expired step.
    const predicate = stepQuery.where.AND[0];
    expect(predicate).toHaveProperty('run');
    expect(predicate.status).toBe('PENDING');
    expect(predicate.humanApprovals).toEqual({ none: { resolvedBy: USER } });
    expect(predicate.OR).toEqual([{ timeoutAt: null }, { timeoutAt: { gt: expect.any(Date) } }]);
    const ids = prisma.workflowRun.findMany.mock.calls[1][0].where.AND[1];
    expect(ids).toEqual({ id: { in: ['mine'] } });
    await app.close();
  });

  it('takes the soonest deadline across every execution of a cross-repo request', async () => {
    const { app, prisma } = await build();
    const late = new Date('2026-06-02T00:00:00Z');
    const soon = new Date('2026-06-01T03:00:00Z');
    // The representative run (first) has no counted step; the second execution holds both.
    prisma.workflowRun.findMany.mockResolvedValueOnce([
      {
        _count: { humanSteps: 0 },
        id: 'rep',
        status: 'RUNNING',
        workflowId: 'a',
        workRequest: { activeWorkflows: [], isCrossRepo: true },
        workRequestId: 'wr',
      },
      {
        _count: { humanSteps: 2 },
        id: 'other',
        status: 'SUCCESS',
        workflowId: 'b',
        workRequest: { activeWorkflows: [], isCrossRepo: true },
        workRequestId: 'wr',
      },
    ]);
    prisma.workflowHumanStep.findMany.mockResolvedValueOnce([
      { id: 's1', runId: 'other', timeoutAt: late },
      { id: 's2', runId: 'other', timeoutAt: soon },
    ]);
    prisma.workflowRun.findMany.mockResolvedValueOnce([
      {
        endedAt: null,
        id: 'rep',
        startedAt: new Date(),
        status: 'RUNNING',
        template: { name: 'T', workspaceProvider: 'git_repo' },
        workflowId: 'a',
        workRequest: {
          _count: { workflowRuns: 2 },
          activeWorkflows: [],
          connection: null,
          description: 'd',
          externalTicketId: 'X-1',
          id: 'wr',
        },
      },
    ]);
    const response = await app.inject({ headers: auth, url: '/runs/requests' });
    const row = response.json().data[0];
    expect(row.pendingStepCount).toBe(2);
    expect(row.pendingStepDeadline).toBe(soon.toISOString());
    await app.close();
  });

  it('skips the control query when no run has a pending step', async () => {
    const { app, prisma } = await build();
    prisma.workflowRun.findMany.mockResolvedValueOnce([latest[0], latest[2]]);
    await app.inject({ headers: auth, url: '/runs/requests?state=attention' });
    expect(prisma.workflowHumanStep.findMany).not.toHaveBeenCalled();
    await app.close();
  });
});
