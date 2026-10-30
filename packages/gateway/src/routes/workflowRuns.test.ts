import { randomBytes } from 'node:crypto';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signEvidenceLink } from '../lib/evidenceDownloadLink.js';
import { TemporalUnavailableError } from '../lib/temporalErrors.js';
import {
  MAX_CONTEXT_ARTIFACT_BYTES,
  MAX_TRACES_PER_READ,
  workflowRunRoutes,
} from './workflowRuns.js';

const { recordRunFinalized, getArtifact } = vi.hoisted(() => ({
  getArtifact: vi.fn(),
  recordRunFinalized: vi.fn(),
}));
vi.mock('../lib/metrics.js', () => ({ recordRunFinalized }));
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({ getArtifact }));
vi.mock('@auto-swe/shared/lib/repoAccessGate', () => ({
  resolveRepoAccessGateOrLastKnown: vi.fn().mockResolvedValue(null),
}));

function newMockPrisma() {
  return {
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    activeWorkflow: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentTrace: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    configAuditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
    },
    runEvidence: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        isActive: true,
        role: 'ENGINEER',
        slackId: null,
      }),
    },
    workflowArtifact: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    workflowRun: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
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

  it('breaks startedAt ties by id, so offset pages neither repeat nor skip a run', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/workflow-runs' });
    expect(res.statusCode).toBe(200);
    expect(prisma.workflowRun.findMany.mock.calls[0][0].orderBy).toEqual([
      { startedAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('narrows to runs where one node failed', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/workflow-runs?failedNodeId=runTests',
    });
    expect(res.statusCode).toBe(200);
    expect(lastListWhere(prisma).steps).toEqual({
      some: { nodeId: 'runTests', status: 'FAILED' },
    });
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

  it.each([
    [
      'the system Agent Run template (reserved origin, no team)',
      'Agent Run',
      'system:agent-run',
      null,
      true,
    ],
    ['a team template merely NAMED Agent Run', 'Agent Run', null, 'team-1', false],
    ['a global template named Agent Run with no system origin', 'Agent Run', null, null, false],
    ['an ordinary template', 'Some Template', null, null, false],
  ])('isAgentRun for %s', async (_label, name, origin, teamId, expected) => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    const row = await prisma.workflowRun.findFirst();
    prisma.workflowRun.findFirst.mockResolvedValue({ ...row, template: { name, origin, teamId } });
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}`,
    });
    expect(res.json().data.isAgentRun).toBe(expected);
  });

  it.each([
    [
      'a run pinned to the harness',
      { 'workspace.implementerRuntime': 'claude-code' },
      'claude-code',
    ],
    ['a run pinned to the Mastra loop', { 'workspace.implementerRuntime': 'mastra' }, 'mastra'],
    ['a run whose pin predates the setting', { 'workflow.maxSteps': 10 }, null],
    ['a run with no pinned settings', null, null],
  ])('implementerRuntime for %s', async (_label, pinnedSettings, expected) => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    const row = await prisma.workflowRun.findFirst();
    prisma.workflowRun.findFirst.mockResolvedValue({ ...row, pinnedSettings });
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}`,
    });
    expect(res.json().data.implementerRuntime).toBe(expected);
  });

  it.each([
    [
      'a run whose agents pinned their runtimes',
      { ciFixer: 'mastra', implementer: 'claude-code' },
      { ciFixer: 'mastra', implementer: 'claude-code' },
    ],
    [
      'a run with a malformed entry and a no-opinion pin',
      { implementer: 'claude-code', junk: 3, reviewer: null },
      { implementer: 'claude-code' },
    ],
    ['a run where nothing resolved one yet', null, {}],
    ['a run whose column holds an array', ['claude-code'], {}],
  ])('agentRuntimes for %s', async (_label, agentRuntimes, expected) => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    const row = await prisma.workflowRun.findFirst();
    prisma.workflowRun.findFirst.mockResolvedValue({ ...row, agentRuntimes });
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}`,
    });
    expect(res.json().data.agentRuntimes).toEqual(expected);
  });

  it('returns the spec snapshot by default and when includeSpec=true', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    for (const qs of ['', '?includeSpec=true']) {
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/workflow-runs/${runId}${qs}`,
      });
      expect(res.json().data.specSnapshot).toEqual({});
    }
    expect(prisma.workflowRun.findFirst.mock.calls[0]?.[0]).toMatchObject({
      omit: { specSnapshot: false },
    });
  });

  it('neither reads nor sends the spec snapshot when includeSpec=false, but still returns steps', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    const row = await prisma.workflowRun.findFirst();
    const { specSnapshot: _spec, ...withoutSpec } = row;
    prisma.workflowRun.findFirst.mockClear();
    prisma.workflowRun.findFirst.mockResolvedValue({
      ...withoutSpec,
      steps: [{ attempt: 1, id: 's1', nodeId: 'n1', status: 'SUCCESS' }],
    });
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}?includeSpec=false`,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect('specSnapshot' in data).toBe(false);
    expect(data.steps).toHaveLength(1);
    expect(prisma.workflowRun.findFirst.mock.calls[0]?.[0]).toMatchObject({
      omit: { specSnapshot: true },
    });
  });

  it('rejects an includeSpec value other than true/false', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}?includeSpec=0`,
    });
    expect(res.statusCode).toBe(400);
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
    expect(res.json().data.tracesTruncated).toBe(false);
    expect(prisma.agentTrace.findMany.mock.calls[0][0].take).toBe(MAX_TRACES_PER_READ + 1);
  });

  it('projects which spec node, branch and attempt each trace belongs to', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    const base = {
      agentKey: 'implementer',
      attempt: 1,
      costUsd: 0,
      createdAt: new Date(),
      durationMs: 1,
      error: null,
      inputJson: null,
      inputTokens: null,
      model: null,
      nodeId: 'executeImplementation',
      otelSpanId: null,
      otelTraceId: null,
      outputJson: null,
      outputTokens: null,
      seq: 0,
      toolName: null,
      type: 'activity_event',
    };
    // The read is newest first; the route hands the page back oldest first.
    prisma.agentTrace.findMany.mockResolvedValue([
      { ...base, id: 't-new', recordingId: 'fan[1]/impl', specNodeId: 'impl', stepAttempt: 2 },
      // A row written before the columns existed.
      { ...base, id: 't-old', recordingId: null, specNodeId: null, stepAttempt: null },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}?includeTraces=true`,
    });
    expect(res.statusCode).toBe(200);
    const traces = res.json().data.traces as Array<Record<string, unknown>>;
    expect(traces.map((t) => [t.id, t.specNodeId, t.recordingId, t.stepAttempt])).toEqual([
      ['t-old', null, null, null],
      ['t-new', 'impl', 'fan[1]/impl', 2],
    ]);
  });

  it('implies includeTraces=true when only fullTraces=true is set', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    mockTraces(prisma);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}?fullTraces=true`,
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
    // The flag is what the run page offers "load full payloads" on.
    expect(trace.trimmed).toBe(true);
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
    expect(trace.trimmed).toBe(false);
  });

  it('flags a trace trimmed only by a long string nested in an array', async () => {
    const { app, prisma } = await buildApp();
    mockRun(prisma);
    const row = (id: string, inputJson: unknown) => ({
      agentKey: 'implementer',
      attempt: 1,
      costUsd: 0,
      createdAt: new Date(),
      durationMs: 1,
      error: null,
      id,
      inputJson,
      inputTokens: 1,
      model: null,
      nodeId: 'n-1',
      otelSpanId: null,
      otelTraceId: null,
      outputJson: null,
      outputTokens: 1,
      seq: 0,
      toolName: null,
      type: 'llm_response',
    });
    prisma.agentTrace.findMany.mockResolvedValue([
      row('nested', { messages: [{ content: LONG_STRING }] }),
      row('short', { text: 'short' }),
    ]);

    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}?includeTraces=true`,
    });

    const traces = res.json().data.traces as { id: string; trimmed: boolean }[];
    expect(traces.find((t) => t.id === 'nested')?.trimmed).toBe(true);
    // Nothing over the cap means nothing to load in full.
    expect(traces.find((t) => t.id === 'short')?.trimmed).toBe(false);
  });
});

describe('workflowRunRoutes GET /:id/traces (live tail)', () => {
  const runId = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';
  const traceRow = (id: string, text: string) => ({
    agentKey: 'implementer',
    attempt: 1,
    costUsd: null,
    createdAt: new Date('2026-09-01T10:00:00.123Z'),
    durationMs: 1,
    error: null,
    id,
    inputJson: { text },
    inputTokens: null,
    model: null,
    nodeId: 'executeImplementation',
    otelSpanId: null,
    otelTraceId: null,
    outputJson: null,
    outputTokens: null,
    recordingId: 'impl',
    seq: 0,
    specNodeId: 'impl',
    stepAttempt: 1,
    toolName: 'bash',
    type: 'tool_call',
  });

  it('returns only traces at or after the cursor, trimmed, behind the visibility filter', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.workflowRun.findFirst.mockResolvedValue({ id: runId });
    prisma.agentTrace.findMany.mockResolvedValue([traceRow('t-new', 'x'.repeat(5_000))]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}/traces?since=2026-09-01T10:00:00.123Z`,
    });
    expect(res.statusCode).toBe(200);

    // The run lookup carries the same visibility predicate as the detail route.
    const runWhere = prisma.workflowRun.findFirst.mock.calls[0][0].where;
    expect(runWhere.id).toBe(runId);
    expect(runWhere.OR).toBeDefined();
    expect(JSON.stringify(runWhere.OR)).toContain('"requestedById":"u-1"');

    expect(prisma.agentTrace.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }, { id: 'desc' }],
      take: MAX_TRACES_PER_READ + 1,
      where: { createdAt: { gte: new Date('2026-09-01T10:00:00.123Z') }, runId },
    });
    expect(res.json().truncated).toBe(false);
    const [trace] = res.json().data;
    expect(trace.id).toBe('t-new');
    expect(trace.trimmed).toBe(true);
    expect(trace.specNodeId).toBe('impl');
  });

  it('counts every trace of the run in the same snapshot as the page', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({ id: runId });
    prisma.agentTrace.findMany.mockResolvedValue([traceRow('t-new', 'x')]);
    prisma.agentTrace.count.mockResolvedValue(7);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}/traces?since=2026-09-01T10:00:00.123Z`,
    });
    expect(res.json().total).toBe(7);
    expect(Number.isNaN(Date.parse(res.json().serverTime))).toBe(false);
    // The count ignores the cursor: it is the run's whole trace, so a caller
    // can compare it with what it holds.
    expect(prisma.agentTrace.count).toHaveBeenCalledWith({ where: { runId } });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Array), {
      isolationLevel: 'RepeatableRead',
    });
  });

  it('returns every trace when no cursor is given', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({ id: runId });
    await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}/traces`,
    });
    expect(prisma.agentTrace.findMany.mock.calls[0][0].where).toEqual({ runId });
  });

  it('caps one read and says when it cut the page', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({ id: runId });
    const rows = Array.from({ length: MAX_TRACES_PER_READ + 1 }, (_, i) => traceRow(`t-${i}`, 'x'));
    prisma.agentTrace.findMany.mockResolvedValue(rows);
    prisma.agentTrace.count.mockResolvedValue(MAX_TRACES_PER_READ + 10);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}/traces`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(MAX_TRACES_PER_READ);
    // Read newest first, the cut drops the oldest row and the page comes back
    // oldest first: t-0 is the newest of the mocked rows, so it comes last.
    expect(res.json().data.at(-1).id).toBe('t-0');
    expect(res.json().data[0].id).toBe(`t-${MAX_TRACES_PER_READ - 1}`);
    expect(res.json().truncated).toBe(true);
    expect(res.json().total).toBe(MAX_TRACES_PER_READ + 10);
  });

  it('404s without reading traces when the run is not visible to the caller', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.workflowRun.findFirst.mockResolvedValue(null);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}/traces`,
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.agentTrace.findMany).not.toHaveBeenCalled();
  });

  it('rejects a cursor that is not an ISO timestamp', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}/traces?since=yesterday`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('workflowRunRoutes POST /:id/cancel', () => {
  const runId = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';

  it('returns 409 when the run finished on its own before the cancel landed', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      workflowId: 'wf-1',
    });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 0 });
    prisma.workflowRun.findUnique.mockResolvedValue({ status: 'COMPLETED' });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'RUN_NOT_RUNNING', message: 'Run reached a terminal state before cancel' },
    });
    expect(temporal.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    expect(prisma.activeWorkflow.updateMany).not.toHaveBeenCalled();
  });

  it('succeeds when the workflow finalised itself as CANCELLED before the row write', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      workflowId: 'wf-1',
    });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 0 });
    prisma.workflowRun.findUnique.mockResolvedValue({ status: 'CANCELLED' });
    recordRunFinalized.mockClear();
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { id: runId, status: 'CANCELLED' } });
    // The workflow's own finalisation ended the run, and counted it.
    expect(recordRunFinalized).not.toHaveBeenCalled();
  });

  it('returns 502 and leaves the run RUNNING when Temporal refuses the cancel', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      workflowId: 'wf-1',
    });
    temporal.cancelWorkflow.mockRejectedValue(new Error('temporal unreachable'));
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('TEMPORAL_CANCEL_FAILED');
    expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
    expect(prisma.activeWorkflow.updateMany).not.toHaveBeenCalled();
  });

  it('returns 503 TEMPORAL_UNAVAILABLE and leaves the run RUNNING when Temporal is not connected', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      workflowId: 'wf-1',
    });
    temporal.cancelWorkflow.mockRejectedValue(new TemporalUnavailableError());
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('TEMPORAL_UNAVAILABLE');
    expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  it('treats a workflow Temporal no longer knows as cancelled', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      workflowId: 'wf-1',
    });
    const notFound = Object.assign(new Error('workflow not found'), {
      name: 'WorkflowNotFoundError',
    });
    temporal.cancelWorkflow.mockRejectedValue(notFound);
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    // No execution is left, but ending the row here would drop its spend from
    // the org cap unbilled: the row stays in flight for the run reaper, which
    // finalizes it through the billing core.
    const update = prisma.workflowRun.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: runId, status: 'RUNNING' });
    expect(update.data).toEqual({ status: 'CANCELLED' });
  });

  it('still ends a channel turn itself when its workflow is already gone', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      template: { name: 'Channel Assistant', teamId: null },
      workflowId: 'channel-turn-2',
    });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    temporal.cancelWorkflow.mockRejectedValue(
      Object.assign(new Error('workflow not found'), { name: 'WorkflowNotFoundError' })
    );
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.workflowRun.updateMany.mock.calls[0][0].data.endedAt).toBeInstanceOf(Date);
  });

  it('cancels the Temporal workflow when the guarded update transitions exactly one row', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      workflowId: 'wf-1',
    });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    recordRunFinalized.mockClear();
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(temporal.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    // The workflow finalizes the run, so the row keeps endedAt null: it stays
    // in flight for the org cap until finalizeWorkflowRun bills its spend.
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith({
      data: { status: 'CANCELLED' },
      where: { id: runId, status: 'RUNNING' },
    });
    expect(recordRunFinalized).toHaveBeenCalledExactlyOnceWith('CANCELLED', 'gateway');
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

  it('ends a cancelled channel turn itself: its workflow finalizes in a cancellable scope', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      template: { name: 'Channel Assistant', teamId: null },
      workflowId: 'channel-turn-1',
    });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(temporal.cancelWorkflow).toHaveBeenCalledWith('channel-turn-1');
    // The cancel rejects the channel workflow's finalizeChannelRun call, so
    // leaving endedAt null would leave the run open forever.
    const update = prisma.workflowRun.updateMany.mock.calls[0][0];
    expect(update.data.status).toBe('CANCELLED');
    expect(update.data.endedAt).toBeInstanceOf(Date);
  });

  it('leaves endedAt to the workflow for a team template named like the channel one', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      template: { name: 'Channel Assistant', teamId: 'team-1' },
      workflowId: 'wf-2',
    });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(prisma.workflowRun.updateMany.mock.calls[0][0].data).toEqual({ status: 'CANCELLED' });
  });
});

describe('workflowRunRoutes GET / (status and templateVersion filters)', () => {
  const templateId = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';
  const list = (app: Awaited<ReturnType<typeof buildApp>>['app'], qs: string) =>
    app.inject({ headers: AUTH, method: 'GET', url: `/api/v1/workflow-runs?${qs}` });

  it('applies status and templateVersion to the list and the count', async () => {
    const { app, prisma } = await buildApp();
    const res = await list(app, `templateId=${templateId}&status=FAILED&templateVersion=2`);

    expect(res.statusCode).toBe(200);
    const expected = { status: 'FAILED', templateId, templateVersion: 2 };
    expect(lastListWhere(prisma)).toMatchObject(expected);
    // Same where for the count, so `total` describes the filtered set.
    expect(prisma.workflowRun.count.mock.calls[0][0].where).toMatchObject(expected);
  });

  it('reports the count of the filtered set as the total', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.count.mockResolvedValue(3);
    const res = await list(app, `templateId=${templateId}&templateVersion=2&limit=1`);
    expect(res.json().meta.total).toBe(3);
  });

  it('adds no templateVersion key when none is given', async () => {
    const { app, prisma } = await buildApp();
    await list(app, `templateId=${templateId}`);
    expect(lastListWhere(prisma)).not.toHaveProperty('templateVersion');
  });

  it('rejects an unknown status', async () => {
    const { app } = await buildApp();
    expect((await list(app, 'status=SUCCEEDED')).statusCode).toBe(400);
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects templateVersion=%s', async (v) => {
    const { app } = await buildApp();
    expect((await list(app, `templateVersion=${v}`)).statusCode).toBe(400);
  });

  it('keeps the repository-share visibility branch alongside the filters for a non-admin', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    await list(app, `templateId=${templateId}&status=FAILED&templateVersion=2`);

    const where = lastListWhere(prisma);
    expect(where).toMatchObject({ status: 'FAILED', templateId, templateVersion: 2 });
    // The filters narrow the visible set; they must not replace it. The OR is
    // the visibility filter, and its repository branches are what let a member
    // of a team a repository is shared with see the owning team's runs. A run
    // reachable only through a share therefore still lists, filtered. There is
    // no template-membership gate on this route, unlike the template-scoped one.
    expect(JSON.stringify(where.OR)).toContain('"shares"');
  });
});

describe('workflowRunRoutes GET / (q text filter)', () => {
  const list = (app: Awaited<ReturnType<typeof buildApp>>['app'], qs: string) =>
    app.inject({ headers: AUTH, method: 'GET', url: `/api/v1/workflow-runs?${qs}` });

  it('matches the description, launch label, ticket ID and template name, case-insensitively', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    expect((await list(app, 'q=JIRA-4077')).statusCode).toBe(200);
    const where = lastListWhere(prisma) as { AND: Record<string, unknown>[] };
    expect(where.AND[1]).toEqual({
      OR: [
        { workRequest: { description: { contains: 'JIRA-4077', mode: 'insensitive' } } },
        { workRequest: { externalTicketId: { contains: 'JIRA-4077', mode: 'insensitive' } } },
        { workRequest: { title: { contains: 'JIRA-4077', mode: 'insensitive' } } },
        { template: { name: { contains: 'JIRA-4077', mode: 'insensitive' } } },
      ],
    });
  });

  it('ANDs the query with the caller visibility filter, so it cannot reach another team', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    await list(app, 'q=auth%20middleware&status=FAILED');
    const where = lastListWhere(prisma) as { AND: Record<string, unknown>[] };
    // The visibility filter (team and repository-share branches) is still in the first term...
    expect(JSON.stringify(where.AND[0].OR)).toContain('"shares"');
    expect(where.AND[0]).toMatchObject({ status: 'FAILED' });
    // ...and the query is a second term, not a replacement for it.
    expect(where.AND).toHaveLength(2);
    expect(where).not.toHaveProperty('OR');
    // The count describes the same filtered set.
    expect(prisma.workflowRun.count.mock.calls[0][0].where).toEqual(where);
  });

  it('keeps the MINE restriction when a query is added', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    await list(app, 'q=x&scope=MINE');
    const where = lastListWhere(prisma) as { AND: Record<string, unknown>[] };
    expect(JSON.stringify(where.AND[0])).toContain('"requestedById":"u-1"');
  });

  it('adds no query term when q is empty, and rejects an over-long one', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    await list(app, 'q=%20%20');
    expect(JSON.stringify(lastListWhere(prisma))).not.toContain('insensitive');
    expect((await list(app, `q=${'a'.repeat(201)}`)).statusCode).toBe(400);
  });
});

describe('workflowRunRoutes with a service principal token', () => {
  const SP = '33333333-3333-4333-8333-333333333333';
  const RUN = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';
  const SERVICE = { authorization: 'Bearer ats_service' };

  async function buildServiceApp(scopes: string[]) {
    const built = await buildApp('ENGINEER');
    const prisma = built.prisma as unknown as Record<string, unknown>;
    prisma.apiToken = {
      findUnique: vi.fn().mockResolvedValue({
        expiresAt: new Date(Date.now() + 86_400_000),
        id: 'tok-1',
        revokedAt: null,
        scopes,
        servicePrincipal: {
          connectionIds: [],
          disabledAt: null,
          id: SP,
          name: 'deployer',
          team: { isActive: true, organization: { isActive: true } },
          teamId: 'team-1',
          templateIds: [],
        },
        servicePrincipalId: SP,
        user: null,
        userId: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    (built.app as unknown as { auth: Record<string, unknown> }).auth.hashToken = (t: string) =>
      `hash:${t}`;
    return built;
  }

  it('lists only the runs the principal requested, whatever scope it asks for', async () => {
    const { app, prisma } = await buildServiceApp(['runs:read']);
    const res = await app.inject({
      headers: SERVICE,
      method: 'GET',
      url: '/api/v1/workflow-runs?scope=ALL',
    });
    expect(res.statusCode).toBe(200);
    expect(lastListWhere(prisma)).toMatchObject({
      workRequest: { requestedByServiceId: SP },
    });
    expect(lastListWhere(prisma)).not.toHaveProperty('OR');
  });

  it('reads one run only through the same filter', async () => {
    const { app, prisma } = await buildServiceApp(['runs:read']);
    const res = await app.inject({
      headers: SERVICE,
      method: 'GET',
      url: `/api/v1/workflow-runs/${RUN}`,
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.workflowRun.findFirst.mock.calls[0][0].where).toEqual({
      id: RUN,
      workRequest: { requestedByServiceId: SP },
    });
  });

  it('refuses traces to a principal, on the run detail and the traces route', async () => {
    const { app, prisma } = await buildServiceApp(['runs:read']);
    for (const q of ['includeTraces=true', 'fullTraces=true']) {
      const res = await app.inject({
        headers: SERVICE,
        method: 'GET',
        url: `/api/v1/workflow-runs/${RUN}?${q}`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('TRACES_NOT_AVAILABLE');
    }
    expect(prisma.agentTrace.findMany).not.toHaveBeenCalled();
  });

  it('needs runs:read to read and runs:cancel to cancel', async () => {
    const { app } = await buildServiceApp(['runs:launch']);
    const list = await app.inject({
      headers: SERVICE,
      method: 'GET',
      url: '/api/v1/workflow-runs',
    });
    expect(list.statusCode).toBe(403);
    const cancel = await app.inject({
      headers: SERVICE,
      method: 'POST',
      url: `/api/v1/workflow-runs/${RUN}/cancel`,
    });
    expect(cancel.statusCode).toBe(403);
    expect(cancel.json().error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('cancels a run it launched and audits the principal, not a user', async () => {
    const { app, prisma, temporal } = await buildServiceApp(['runs:cancel']);
    prisma.workflowRun.findFirst.mockResolvedValueOnce({
      id: RUN,
      status: 'RUNNING',
      template: { name: 'Agent Run', teamId: null },
      workflowId: 'agent-x',
    });
    const res = await app.inject({
      headers: SERVICE,
      method: 'POST',
      url: `/api/v1/workflow-runs/${RUN}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.workflowRun.findFirst.mock.calls[0][0].where).toMatchObject({
      workRequest: { requestedByServiceId: SP },
    });
    expect(temporal.cancelWorkflow).toHaveBeenCalledWith('agent-x');
    expect(prisma.configAuditLog.create.mock.calls[0][0].data).toMatchObject({
      actorId: null,
      afterJson: { servicePrincipalId: SP, status: 'CANCELLED' },
    });
  });

  it('cannot read a spilled artifact, because that route does not opt in', async () => {
    const { app } = await buildServiceApp(['runs:read']);
    const res = await app.inject({
      headers: SERVICE,
      method: 'GET',
      url: `/api/v1/workflow-runs/${RUN}/artifacts/7a9619ff-8b86-4a08-8b86-3e6f9619ffd2`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SERVICE_TOKEN_NOT_ALLOWED');
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it('cannot reach a run route that does not opt in', async () => {
    const { app } = await buildServiceApp(['runs:read', 'runs:cancel', 'runs:launch']);
    const res = await app.inject({
      headers: SERVICE,
      method: 'GET',
      url: `/api/v1/workflow-runs/${RUN}/traces`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SERVICE_TOKEN_NOT_ALLOWED');
  });
});

describe('workflowRunRoutes GET /:id/artifacts/:artifactId (context overflow text)', () => {
  const RUN = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';
  const ART = '7a9619ff-8b86-4a08-8b86-3e6f9619ffd2';
  const url = `/api/v1/workflow-runs/${RUN}/artifacts/${ART}`;
  const FIXED = 'Artifact not found';

  async function buildReadable(sizeBytes = 11) {
    const built = await buildApp('ENGINEER');
    built.prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN });
    built.prisma.workflowArtifact.findFirst.mockResolvedValue({ id: ART, sizeBytes });
    return built;
  }

  it('returns the text and its size for a ready context-overflow artifact of the run', async () => {
    const { app, prisma } = await buildReadable();
    getArtifact.mockResolvedValue({ body: Buffer.from('héllo world', 'utf8'), ref: {} });
    const res = await app.inject({ headers: AUTH, method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { sizeBytes: 12, text: 'héllo world' } });
    expect(prisma.workflowArtifact.findFirst.mock.calls[0][0].where).toEqual({
      id: ART,
      kind: 'context-overflow',
      runId: RUN,
      status: 'ready',
    });
  });

  it('answers 404 RUN_NOT_FOUND when the run is not visible, reading nothing', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    const res = await app.inject({ headers: AUTH, method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RUN_NOT_FOUND');
    expect(prisma.workflowRun.findFirst.mock.calls[0][0].where).toMatchObject({ id: RUN });
    expect(prisma.workflowArtifact.findFirst).not.toHaveBeenCalled();
    expect(getArtifact).not.toHaveBeenCalled();
  });

  // Ownership, kind and status are all part of one lookup, so a missing row, another run's
  // artifact, a transcript part and a pending upload are the same answer.
  it('answers one indistinguishable 404 when the artifact is missing, foreign, wrong kind or not ready', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN });
    prisma.workflowArtifact.findFirst.mockResolvedValue(null);
    const res = await app.inject({ headers: AUTH, method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: 'ARTIFACT_NOT_FOUND', message: FIXED });
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it('answers 404 for another run’s artifact id, reading no bytes', async () => {
    // The mock honours the where clause: only a row owned by RUN would match.
    const { app, prisma } = await buildReadable();
    prisma.workflowArtifact.findFirst.mockImplementation(
      async ({ where }: { where: { runId: string } }) =>
        where.runId === '99999999-9999-4999-8999-999999999999' ? { id: ART, sizeBytes: 3 } : null
    );
    const res = await app.inject({ headers: AUTH, method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ARTIFACT_NOT_FOUND');
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it('answers a fixed 502 without internals when the blob cannot be read', async () => {
    const { app } = await buildReadable();
    getArtifact.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:9000 bucket=secret'));
    const res = await app.inject({ headers: AUTH, method: 'GET', url });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toEqual({
      code: 'ARTIFACT_READ_FAILED',
      message: 'The artifact could not be read',
    });
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('refuses an artifact larger than the cap, without reading its bytes', async () => {
    const { app } = await buildReadable(MAX_CONTEXT_ARTIFACT_BYTES + 1);
    const res = await app.inject({ headers: AUTH, method: 'GET', url });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('ARTIFACT_TOO_LARGE');
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it('keeps a cap no legitimate spill can exceed (8M UTF-16 units at 3 UTF-8 bytes each)', () => {
    expect(MAX_CONTEXT_ARTIFACT_BYTES).toBeGreaterThanOrEqual(8_000_000 * 3);
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a caller whose role is below ENGINEER', async () => {
    const { app } = await buildApp('ENGINEER');
    (app as unknown as { auth: { verifyAccessToken: unknown } }).auth.verifyAccessToken = () => ({
      exp: 9999999999,
      iat: 0,
      role: 'VIEWER',
      sub: 'u-1',
    });
    const res = await app.inject({ headers: AUTH, method: 'GET', url });
    expect(res.statusCode).toBe(403);
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it('refuses a malformed artifact id', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${RUN}/artifacts/not-a-uuid`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('workflowRunRoutes UI evidence', () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const evidenceId = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
  });

  it('lists ready evidence only after checking run visibility', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.workflowRun.findFirst.mockResolvedValue({ id: runId });
    prisma.runEvidence.findMany.mockResolvedValue([
      {
        artifact: { contentType: 'image/png', sizeBytes: 12, status: 'ready' },
        caption: 'Landing page',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        height: 480,
        id: evidenceId,
        kind: 'screenshot',
        pageUrl: 'http://localhost:3000/',
        source: 'uiVerify',
        specNodeId: 'smoke',
        stepAttempt: 1,
        width: 640,
      },
      {
        artifact: { contentType: 'image/png', sizeBytes: 10, status: 'pending' },
        createdAt: new Date(),
        id: '33333333-3333-4333-8333-333333333333',
        kind: 'screenshot',
        source: 'uiVerify',
      },
    ]);

    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}/evidence`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0]).toMatchObject({
      contentType: 'image/png',
      id: evidenceId,
      sizeBytes: 12,
      specNodeId: 'smoke',
    });
    expect(prisma.workflowRun.findFirst.mock.calls[0][0].where).toMatchObject({ id: runId });
  });

  it('rechecks run visibility on each signed content fetch and sets safe media headers', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.workflowRun.findFirst.mockResolvedValueOnce({ id: runId }).mockResolvedValueOnce(null);
    prisma.runEvidence.findFirst.mockResolvedValue({
      artifact: { contentType: 'image/png', sizeBytes: 5, status: 'ready' },
      artifactId: 'artifact-1',
      id: evidenceId,
      kind: 'screenshot',
    });
    getArtifact.mockResolvedValue({ body: Buffer.from('image') });
    const { token } = signEvidenceLink({ eid: evidenceId, rid: runId, sub: 'u-1' });
    const url = `/api/v1/workflow-runs/${runId}/evidence/${evidenceId}/content?token=${encodeURIComponent(token)}`;

    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('image');
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toContain('inline; filename="screenshot-');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(res.headers['cache-control']).toBe('private, max-age=300');

    const second = await app.inject({ method: 'GET', url });
    expect(second.statusCode).toBe(404);
    expect(prisma.workflowRun.findFirst).toHaveBeenCalledTimes(2);
  });

  it('serves unapproved artifact types as octet-stream attachments', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.workflowRun.findFirst.mockResolvedValue({ id: runId });
    prisma.runEvidence.findFirst.mockResolvedValue({
      artifact: { contentType: 'text/html', sizeBytes: 5, status: 'ready' },
      artifactId: 'artifact-1',
      id: evidenceId,
      kind: 'trace',
    });
    getArtifact.mockResolvedValue({ body: Buffer.from('<html>') });
    const { token } = signEvidenceLink({ eid: evidenceId, rid: runId, sub: 'u-1' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}/evidence/${evidenceId}/content?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('attachment; filename="trace-');
  });
});
