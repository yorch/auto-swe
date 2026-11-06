import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  active: new Map<string, { currentStatus: string; workRequest?: unknown }>(),
  createActive: vi.fn(),
  createInput: vi.fn(),
  feedback: vi.fn(),
  inputs: new Map<string, unknown>(),
  limits: {
    'workspace.agentRunMaxConcurrentGlobal': 4,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
  },
  repo: vi.fn(),
  source: vi.fn(),
  start: vi.fn(),
  template: vi.fn(),
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSettings: vi.fn(async () => m.limits) }));
vi.mock('@auto-swe/shared/lib/billing', () => ({
  orgMonthSpend: vi.fn(async () => ({ totalUsd: 0 })),
  usdToCents: (usd: number) => usd * 100,
}));
vi.mock('../lib/launchAudit.js', () => ({ recordWorkerLaunchAudit: vi.fn() }));
vi.mock('../lib/ciLogGuard.js', async (original) => ({
  ...(await original<typeof import('../lib/ciLogGuard.js')>()),
  feedbackInjectionScreen: vi.fn(async () => new Set<number>()),
}));
vi.mock('../lib/storedAgentChange.js', () => ({ loadStoredAgentChange: m.source }));
vi.mock('../lib/reviewFeedback.js', () => ({ readReviewFeedback: m.feedback }));
vi.mock('../lib/temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { start: m.start } }),
}));
vi.mock('@auto-swe/shared/db', () => {
  const db = {
    $executeRaw: vi.fn(),
    activeWorkflow: {
      create: m.createActive,
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(
        async ({ where }: { where: { temporalWorkflowId: string } }) =>
          m.active.get(where.temporalWorkflowId) ?? null
      ),
      updateMany: vi.fn(async ({ where }: { where: { temporalWorkflowId: string } }) => {
        m.active.set(where.temporalWorkflowId, { currentStatus: 'FAILED' });
      }),
    },
    connection: { findUnique: m.repo },
    runInput: { create: m.createInput },
    workflowTemplate: { findFirst: m.template },
  };
  return { prisma: { ...db, $transaction: async (fn: (tx: unknown) => unknown) => fn(db) } };
});

import { startStoredReviewFix } from './storedReviewFix.js';

const payload = {
  connectionId: 'repo',
  onBlocking: 'fix' as const,
  reviewOf: { mode: 'stored' as const },
  sourceRunId: 'source',
};
beforeEach(() => {
  vi.clearAllMocks();
  m.active.clear();
  m.inputs.clear();
  m.limits = {
    'workspace.agentRunMaxConcurrentGlobal': 4,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
  };
  m.createInput.mockImplementation(async ({ data }) => {
    m.inputs.set(data.id, data);
  });
  m.createActive.mockImplementation(async ({ data }) => {
    m.active.set(data.temporalWorkflowId, {
      ...data,
      workRequest: m.inputs.get(data.workRequestId),
    });
  });
  m.start.mockResolvedValue({});
  m.repo.mockResolvedValue({
    id: 'repo',
    isActive: true,
    team: {
      isActive: true,
      organization: { id: 'org', isActive: true, monthlyBudgetUsdCents: null },
    },
    teamId: 'team',
    type: 'git_repo',
  });
  m.template.mockResolvedValue({ activeVersion: 2, id: 'agent-template' });
  m.source.mockResolvedValue({
    agentPayload: {
      agentRef: 'docsMaintainer@3',
      baseBranch: 'release/1',
      deliver: 'none',
      maxSteps: 10,
    },
    baseSha: 'a'.repeat(40),
    description: 'original task',
    diff: 'stored diff',
    launchedById: 'launcher',
  });
  m.feedback.mockResolvedValue({
    approved: false,
    origin: 'agent_run',
    sourceRunId: 'source',
    status: 'SUCCESS',
    storedChange: { baseSha: 'a'.repeat(40), diff: 'stored diff' },
    texts: ['Fix the unchecked null value in a.ts'],
  });
});
describe('stored review follow-ups', () => {
  it('uses the same agent and source parameters, DB findings, deliver:none and a ledger-first launch', async () => {
    const result = await startStoredReviewFix(payload, 'review');
    expect(result.status).toBe('started');
    expect(m.createInput).toHaveBeenCalledWith({
      data: expect.objectContaining({
        description: expect.stringContaining('unchecked null'),
        payload: expect.objectContaining({
          agentRef: 'docsMaintainer@3',
          baseBranch: 'release/1',
          deliver: 'none',
          reviewFixOfRunId: 'review',
        }),
        requestedById: 'launcher',
      }),
    });
    expect(m.createActive).toHaveBeenCalledWith({
      data: expect.objectContaining({ assignedBranch: null }),
    });
    expect(m.createInput.mock.invocationCallOrder[0]).toBeLessThan(
      m.start.mock.invocationCallOrder[0] ?? 0
    );
    expect(m.start.mock.calls[0]?.[1].args[0]).toMatchObject({
      request: { payload: { deliver: 'none' } },
      templateId: 'agent-template',
    });
  });
  it('deduplicates each review/attempt, and allocates a new identity for retry', async () => {
    const first = await startStoredReviewFix(payload, 'review');
    expect(await startStoredReviewFix(payload, 'review')).toEqual(first);
    expect(m.createInput).toHaveBeenCalledTimes(1);
    m.repo.mockResolvedValueOnce(null);
    expect(await startStoredReviewFix(payload, 'review')).toEqual(first);
    m.repo.mockReset();
    m.repo.mockResolvedValue({
      id: 'repo',
      isActive: true,
      team: {
        isActive: true,
        organization: { id: 'org', isActive: true, monthlyBudgetUsdCents: null },
      },
      teamId: 'team',
      type: 'git_repo',
    });
    expect(await startStoredReviewFix(payload, 'review', 'attempt-2')).not.toEqual(first);
    expect(m.createInput).toHaveBeenCalledTimes(2);
  });
  it('records a transient launch failure and can retry under a new attempt', async () => {
    m.start.mockRejectedValueOnce(new Error('unavailable'));
    expect(await startStoredReviewFix(payload, 'review')).toMatchObject({
      reason: 'the fix workflow could not start',
      status: 'skipped',
    });
    expect(await startStoredReviewFix(payload, 'review', 'retry')).toMatchObject({
      status: 'started',
    });
  });
  it('skips an unverified target, unavailable agent, empty findings, or disabled agents', async () => {
    m.feedback.mockResolvedValueOnce(null);
    expect((await startStoredReviewFix(payload, 'review')).status).toBe('skipped');
    m.source.mockResolvedValueOnce({ baseSha: 'a'.repeat(40), diff: 'stored diff' });
    expect((await startStoredReviewFix(payload, 'review')).status).toBe('skipped');
    m.feedback.mockResolvedValueOnce({
      origin: 'agent_run',
      sourceRunId: 'source',
      storedChange: { baseSha: 'a'.repeat(40), diff: 'stored diff' },
      texts: [],
    });
    expect((await startStoredReviewFix(payload, 'review')).status).toBe('skipped');
    m.limits['workspace.agentRunMaxConcurrentGlobal'] = 0;
    expect(await startStoredReviewFix(payload, 'review')).toMatchObject({
      reason: 'agent runs are disabled',
      status: 'skipped',
    });
    expect(m.start).not.toHaveBeenCalled();
  });
});
