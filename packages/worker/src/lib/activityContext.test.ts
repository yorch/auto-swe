import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  notePersistedUsage: vi.fn(),
}));

vi.mock('@temporalio/activity', () => ({
  activityInfo: () => ({
    activityType: 'generateWorkflowSpec',
    attempt: 1,
    workflowExecution: { runId: 'temporal-run-1', workflowId: 'wf-author-1' },
  }),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agentTrace: { createMany: h.createMany },
    workflowRun: { findUnique: async () => null },
  },
}));
vi.mock('./spendOwner.js', () => ({
  currentSpendOwner: async () => ({ orgId: 'org-1', teamId: 'team-1' }),
}));
vi.mock('./runlessBudget.js', () => ({ notePersistedUsage: h.notePersistedUsage }));

import { persistActivityTrace } from './activityContext.js';
import { AgentTracer } from './agentTracer.js';

describe('persistActivityTrace', () => {
  it('writes the execution and spend owner, then hands the persisted tokens to the runless sum', async () => {
    const tracer = new AgentTracer();
    tracer.addLlmResponse({ durationMs: 1, inputTokens: 120, outputTokens: 30, role: 'r' });
    tracer.addLlmResponse({ durationMs: 1, inputTokens: 80, outputTokens: 20, role: 'r' });
    tracer.addActivityEvent({ name: 'e' });

    await persistActivityTrace(tracer, 'workflowAuthor');

    expect(h.createMany.mock.calls[0]?.[0]).toMatchObject({
      data: [
        {
          orgId: 'org-1',
          runId: null,
          teamId: 'team-1',
          temporalRunId: 'temporal-run-1',
          workflowId: 'wf-author-1',
        },
        expect.anything(),
        expect.anything(),
      ],
    });
    expect(h.notePersistedUsage).toHaveBeenCalledWith('wf-author-1', 'temporal-run-1', 200, 50);
  });
});
