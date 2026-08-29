import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workflowTemplateRoutes } from './workflowTemplates.js';

describe('POST /api/v1/workflow-templates/:id/runs (generic trigger)', () => {
  const TEMPLATE_ID = 'a1b2c3d4-1234-4567-89ab-cdef01234567';
  const USER_ID = 'user-1';

  let app: ReturnType<typeof Fastify>;
  let startedWorkflows: Array<{ input: unknown; workflowId: string }>;

  beforeAll(() => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    startedWorkflows = [];

    app.decorate('auth', {
      verifyAccessToken: () => ({
        exp: 9999999999,
        iat: 0,
        role: 'ENGINEER',
        sub: USER_ID,
      }),
    } as unknown as never);

    const runInputCreates: Array<Record<string, unknown>> = [];
    const activeWorkflowCreates: Array<Record<string, unknown>> = [];

    const prismaMock = {
      $queryRaw: async () => [],
      $transaction: async (arg: unknown) => {
        if (Array.isArray(arg)) {
          const results: Array<{ id: string }> = [];
          for (const write of arg) {
            const result = await write;
            results.push(result);
          }
          return results;
        }
        if (typeof arg === 'function') {
          return arg(prismaMock);
        }
        return undefined;
      },
      activeWorkflow: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          activeWorkflowCreates.push(data);
          return { id: 'aw-1', ...data };
        },
      },
      connection: {
        findUnique: async () => null,
      },
      orgMonthlyUsage: {
        findUnique: async () => null,
      },
      runInput: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          runInputCreates.push(data);
          return { id: data.id as string, ...data };
        },
      },
      workflowTemplate: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id !== TEMPLATE_ID) {
            return null;
          }
          return {
            activeVersion: 1,
            id: TEMPLATE_ID,
            inputSchema: null,
            team: {
              id: 'team-1',
              organization: { id: 'org-1', monthlyBudgetUsdCents: null },
            },
            teamId: 'team-1',
            workspaceProvider: 'api_only',
          };
        },
      },
    };

    app.decorate('prisma', prismaMock as unknown as never);
    app.decorate('temporal', {
      startRunnableWorkflow: async (workflowId: string, input: unknown) => {
        startedWorkflows.push({ input, workflowId });
      },
    } as unknown as never);

    app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts a run for an api_only template without a connection', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: { label: 'test-run', payload: { budget: 'STANDARD' } },
      url: `/api/v1/workflow-templates/${TEMPLATE_ID}/runs`,
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.data.workRequestId).toBeTruthy();
    expect(body.data.temporalWorkflowId).toMatch(/^wf-/);
    expect(startedWorkflows).toHaveLength(1);
  });

  it('returns 404 for an unknown template', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {},
      url: '/api/v1/workflow-templates/00000000-0000-0000-0000-000000000000/runs',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.payload);
    expect(body.error.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('returns 402 when the organization is over its monthly budget cap', async () => {
    startedWorkflows.length = 0;
    (
      app.prisma as unknown as { orgMonthlyUsage: { findUnique: () => Promise<unknown> } }
    ).orgMonthlyUsage.findUnique = async () => ({ costUsdAccrued: 100 });
    (
      app.prisma as unknown as {
        workflowTemplate: {
          findFirst: (args: { where: Record<string, unknown> }) => Promise<unknown>;
        };
      }
    ).workflowTemplate.findFirst = async ({ where }: { where: Record<string, unknown> }) => {
      if (where.id !== TEMPLATE_ID) {
        return null;
      }
      return {
        activeVersion: 1,
        id: TEMPLATE_ID,
        inputSchema: null,
        team: {
          id: 'team-1',
          organization: { id: 'org-1', monthlyBudgetUsdCents: 5000 },
        },
        teamId: 'team-1',
        workspaceProvider: 'api_only',
      };
    };

    const response = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: { label: 'test-run', payload: { budget: 'STANDARD' } },
      url: `/api/v1/workflow-templates/${TEMPLATE_ID}/runs`,
    });

    expect(response.statusCode).toBe(402);
    const body = JSON.parse(response.payload);
    expect(body.error.code).toBe('ORG_BUDGET_EXCEEDED');
    expect(startedWorkflows).toHaveLength(0);
  });

  it('passes generic payload and connectionId to the workflow for document templates', async () => {
    startedWorkflows.length = 0;
    const connectionId = '11111111-1111-4111-8111-111111111111';

    (
      app.prisma as unknown as { connection: { findUnique: () => Promise<unknown> } }
    ).connection.findUnique = async () => ({
      isActive: true,
      team: {
        memberships: [{ userId: USER_ID }],
        organization: { id: 'org-1', monthlyBudgetUsdCents: null },
      },
      type: 'notion',
    });

    (
      app.prisma as unknown as {
        workflowTemplate: {
          findFirst: (args: { where: Record<string, unknown> }) => Promise<unknown>;
        };
      }
    ).workflowTemplate.findFirst = async ({ where }: { where: Record<string, unknown> }) => {
      if (where.id !== TEMPLATE_ID) {
        return null;
      }
      return {
        activeVersion: 1,
        id: TEMPLATE_ID,
        inputSchema: null,
        team: {
          id: 'team-1',
          organization: { id: 'org-1', monthlyBudgetUsdCents: null },
        },
        teamId: 'team-1',
        workspaceProvider: 'document',
      };
    };

    const payload = {
      connectionId,
      instructions: 'Summarise',
      sourcePageId: 'src-page',
      targetPageId: 'tgt-page',
    };
    const response = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: { label: 'notion-run', payload },
      url: `/api/v1/workflow-templates/${TEMPLATE_ID}/runs`,
    });

    expect(response.statusCode).toBe(201);
    expect(startedWorkflows).toHaveLength(1);
    const { input } = startedWorkflows[0];
    expect((input as { request: { connectionId: string } }).request.connectionId).toBe(
      connectionId
    );
    expect((input as { request: { repoId: string | null } }).request.repoId).toBe(connectionId);
    expect((input as { request: { payload: Record<string, unknown> } }).request.payload).toEqual(
      payload
    );
  });
});
