import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workRequestRoutes } from './workRequests.js';

/**
 * `POST /work-requests/:id/retry` answers with the Temporal workflow id it
 * started. The WorkflowRun row is created later by the worker, keyed by that
 * id, so it is the only handle a client has to find the new run.
 */

const WORK_REQUEST_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

describe('POST /work-requests/:id/retry', () => {
  let app: FastifyInstance;
  let started: string[];

  beforeEach(async () => {
    started = [];
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' }),
    } as unknown as never);

    const prismaMock = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      $transaction: async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : undefined),
      activeWorkflow: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'aw-new',
          ...data,
        }),
        delete: async () => ({}),
        findMany: async () => [],
      },
      organizationMembership: { findUnique: async () => ({ role: 'ORG_MEMBER' }) },
      orgMonthlyUsage: { findUnique: async () => null },
      runInput: {
        findUnique: async () => ({
          activeWorkflows: [
            {
              assignedBranch: 'auto/T-1',
              budgetTier: 'STANDARD',
              repository: {
                githubUrl: null,
                id: 'repo-1',
                installation: null,
                isActive: true,
                organizationName: 'org',
                repoName: 'test',
                shares: [],
                team: {
                  memberships: [{ userId: 'user-1' }],
                  organization: { id: 'org-1', monthlyBudgetUsdCents: null },
                  orgId: 'org-1',
                },
                teamId: 'team-1',
                type: 'git_repo',
              },
            },
          ],
          description: 'do it',
          externalTicketId: 'T-1',
          id: WORK_REQUEST_ID,
          requestPayload: null,
          templateId: 'tpl-1',
          templateVersion: 2,
        }),
      },
    };
    app.decorate('prisma', prismaMock as unknown as never);
    app.decorate('temporal', {
      startRunnableWorkflow: async (workflowId: string) => {
        started.push(workflowId);
      },
    } as unknown as never);
    app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
    await app.ready();
  });

  afterEach(() => app.close());

  it('returns the Temporal workflow id it started alongside the ledger id', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer t' },
      method: 'POST',
      payload: {},
      url: `/api/v1/work-requests/${WORK_REQUEST_ID}/retry`,
    });

    expect(res.statusCode).toBe(201);
    expect(started).toHaveLength(1);
    const { data } = res.json();
    expect(data.temporalWorkflowId).toBe(started[0]);
    expect(data.workRequestId).toBe(WORK_REQUEST_ID);
    expect(data.workflowIds).toEqual(['aw-new']);
  });
});
