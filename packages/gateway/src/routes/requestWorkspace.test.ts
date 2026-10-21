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
async function build(role = 'ENGINEER') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = { workflowRun: { findMany: vi.fn() } };
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
        humanSteps: [{ timeoutAt: new Date('2026-06-01T03:00:00Z') }, { timeoutAt: null }],
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
    expect(row.pendingStepDeadline).toBe('2026-06-01T03:00:00.000Z');
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
