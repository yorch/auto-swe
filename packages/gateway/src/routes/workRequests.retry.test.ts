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
  /** The snapshot template row the retry looks up; null = an ordinary template. */
  let snapshotTemplate: { origin: string | null; teamId: string | null } | null;
  /** The launchable row (ACTIVE + visible to the caller); null = archived or off-team. */
  let launchable: { inputSchema: unknown } | null;
  let launchWhere: unknown;
  let payload: Record<string, unknown> | null;

  beforeEach(async () => {
    started = [];
    snapshotTemplate = null;
    launchable = { inputSchema: null };
    launchWhere = undefined;
    payload = { ticket: 'T-1' };
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
      connection: { findUnique: async () => null },
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
          payload,
          requestPayload: null,
          templateId: 'tpl-1',
          templateVersion: 2,
        }),
      },
      workflowTemplate: {
        findFirst: async ({ where }: { where: { status?: string } }) => {
          if (where.status) {
            launchWhere = where;
            return launchable;
          }
          return snapshotTemplate;
        },
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

  it('refuses to retry an agent run (its payload is dropped and its branch would collide)', async () => {
    snapshotTemplate = { origin: 'system:agent-run', teamId: null };
    const res = await app.inject({
      headers: { authorization: 'Bearer t' },
      method: 'POST',
      payload: {},
      url: `/api/v1/work-requests/${WORK_REQUEST_ID}/retry`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('USE_AGENT_RUN_RERUN');
    expect(started).toHaveLength(0);
  });

  const retry = () =>
    app.inject({
      headers: { authorization: 'Bearer t' },
      method: 'POST',
      payload: {},
      url: `/api/v1/work-requests/${WORK_REQUEST_ID}/retry`,
    });

  it('refuses a git-backed retry of a template that is archived or off the caller’s team', async () => {
    launchable = null;
    const res = await retry();
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TEMPLATE_NOT_FOUND');
    expect(launchWhere).toMatchObject({ id: 'tpl-1', status: 'ACTIVE' });
    expect(started).toHaveLength(0);
  });

  it('refuses a git-backed retry whose recorded inputs fail the input schema', async () => {
    launchable = {
      inputSchema: { properties: { ticket: { type: 'number' } }, type: 'object' },
    };
    const res = await retry();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
    expect(started).toHaveLength(0);
  });

  it('launches a git-backed retry whose inputs satisfy the schema', async () => {
    launchable = {
      inputSchema: { properties: { ticket: { type: 'string' } }, type: 'object' },
    };
    expect((await retry()).statusCode).toBe(201);
    expect(started).toHaveLength(1);
  });

  it('skips the schema check for a request with no recorded payload', async () => {
    payload = null;
    launchable = { inputSchema: { properties: {}, required: ['x'], type: 'object' } };
    expect((await retry()).statusCode).toBe(201);
  });
});
