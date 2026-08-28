import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowRunRoutes } from './workflowRuns.js';

function newMockPrisma() {
  return {
    agentTrace: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    configAuditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
    },
    workflowRun: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  const temporal = { cancelWorkflow: vi.fn().mockResolvedValue(undefined) };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('temporal', temporal as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'u-1' }),
  } as unknown as never);
  await app.register(workflowRunRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.ready();
  return { app, prisma, temporal };
}

const AUTH = { authorization: 'Bearer fake' };

function lastListWhere(prisma: ReturnType<typeof newMockPrisma>) {
  return prisma.workflowRun.findMany.mock.calls[0][0].where as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('workflowRunRoutes GET / (list)', () => {
  it('excludes channel chatter runs by default', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/workflow-runs' });
    expect(res.statusCode).toBe(200);
    const where = lastListWhere(prisma);
    expect(where.template).toEqual({ name: { notIn: ['Channel Assistant', 'Channel Task'] } });
  });

  it('includes channel chatter runs when includeChannel=true', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/workflow-runs?includeChannel=true',
    });
    expect(res.statusCode).toBe(200);
    const where = lastListWhere(prisma);
    expect(where.template).toBeUndefined();
  });

  it('does not add the channel exclusion when a templateId filter is set', async () => {
    const { app, prisma } = await buildApp();
    const templateId = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs?templateId=${templateId}`,
    });
    expect(res.statusCode).toBe(200);
    const where = lastListWhere(prisma);
    expect(where.template).toBeUndefined();
    expect(where.templateId).toBe(templateId);
  });

  // Regression: z.coerce.boolean() treats the *string* "false" as truthy
  // (Boolean("false") === true), so an explicit ?includeChannel=false used to
  // silently opt IN to channel chatter runs instead of respecting the caller.
  it('excludes channel chatter runs when includeChannel=false is explicit', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/workflow-runs?includeChannel=false',
    });
    expect(res.statusCode).toBe(200);
    const where = lastListWhere(prisma);
    expect(where.template).toEqual({ name: { notIn: ['Channel Assistant', 'Channel Task'] } });
  });

  it('rejects an includeChannel value other than true/false', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/workflow-runs?includeChannel=1',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('workflowRunRoutes GET /:id (detail)', () => {
  const runId = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';
  const LONG_STRING = 'x'.repeat(5_000);

  function mockRun(prisma: ReturnType<typeof newMockPrisma>) {
    prisma.workflowRun.findFirst.mockResolvedValue({
      contextSnapshot: null,
      costUsdAccrued: 0,
      endedAt: null,
      id: runId,
      specSnapshot: {},
      startedAt: new Date(),
      status: 'RUNNING',
      steps: [],
      template: { name: 'Some Template' },
      templateId: 't-1',
      templateVersion: 1,
      tokensInputTotal: 0,
      tokensOutputTotal: 0,
      workflowId: 'wf-1',
      workRequest: { description: 'd', externalTicketId: 'JIRA-1', id: 'wr-1' },
    });
  }

  function mockTraces(prisma: ReturnType<typeof newMockPrisma>) {
    prisma.agentTrace.findMany.mockResolvedValue([
      {
        agentKey: 'implementer',
        attempt: 1,
        costUsd: 0,
        createdAt: new Date(),
        durationMs: 1,
        error: null,
        id: 'trace-1',
        inputJson: { text: LONG_STRING },
        inputTokens: 1,
        model: 'anthropic/claude-opus-4-8',
        nodeId: 'n-1',
        otelSpanId: null,
        otelTraceId: null,
        outputJson: { text: LONG_STRING },
        outputTokens: 1,
        seq: 1,
        toolName: null,
        type: 'llm_response',
      },
    ]);
  }

  it('omits traces and skips the agentTrace query by default', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.traces).toEqual([]);
    expect(prisma.agentTrace.findMany).not.toHaveBeenCalled();
  });

  it('omits traces when includeTraces=false is explicit', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}?includeTraces=false`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.traces).toEqual([]);
    expect(prisma.agentTrace.findMany).not.toHaveBeenCalled();
  });

  it('returns traces when includeTraces=true', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    mockTraces(prisma);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}?includeTraces=true`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.traces).toHaveLength(1);
    expect(prisma.agentTrace.findMany).toHaveBeenCalled();
  });

  // Regression: ?fullTraces=false used to coerce to `true` and return
  // untrimmed trace payloads (a forensic-only escape hatch) by default.
  it('trims large trace fields when fullTraces=false is explicit', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    mockTraces(prisma);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}?includeTraces=true&fullTraces=false`,
    });
    expect(res.statusCode).toBe(200);
    const [trace] = res.json().data.traces;
    expect(trace.inputJson.text.length).toBeLessThan(LONG_STRING.length);
    expect(trace.inputJson.text).toContain('[truncated');
  });

  it('returns untrimmed trace fields when fullTraces=true', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    mockTraces(prisma);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}?includeTraces=true&fullTraces=true`,
    });
    expect(res.statusCode).toBe(200);
    const [trace] = res.json().data.traces;
    expect(trace.inputJson.text).toBe(LONG_STRING);
  });
});

describe('workflowRunRoutes POST /:id/cancel', () => {
  const runId = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';

  it('returns 409 and skips the Temporal cancel when the run already left RUNNING', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      workflowId: 'wf-1',
    });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 0 });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'RUN_NOT_RUNNING', message: 'Run reached a terminal state before cancel' },
    });
    expect(temporal.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('cancels the Temporal workflow when the guarded update transitions exactly one row', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      workflowId: 'wf-1',
    });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(temporal.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    expect(prisma.configAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UPDATE',
          afterJson: { status: 'CANCELLED' },
          beforeJson: { status: 'RUNNING' },
          entityId: runId,
          entityType: 'WorkflowRun',
        }),
      })
    );
  });
});
