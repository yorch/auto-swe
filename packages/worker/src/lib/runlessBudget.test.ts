import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  aggregate: vi.fn(),
  resolveSettings: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agentTrace: { aggregate: h.aggregate },
    workflowRun: { findUnique: h.run },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSettings: h.resolveSettings }));
vi.mock('./spendOwner.js', () => ({
  currentSpendOwner: async () => ({ orgId: 'org-1', teamId: 'team-1' }),
}));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));

import {
  _resetRunlessBudgetForTests,
  assertRunlessBudgetAvailable,
  recordRunlessUsage,
  takePersistingUsage,
  withRunlessCapScale,
} from './runlessBudget.js';

const call = (inputTokens: number, outputTokens: number) => ({
  costUsd: 0.01,
  inputTokens,
  modelSpec: 'anthropic/x',
  outputTokens,
});

function persisted(inputTokens: number, outputTokens: number) {
  h.aggregate.mockResolvedValue({ _sum: { inputTokens, outputTokens } });
}

beforeEach(() => {
  vi.resetAllMocks();
  _resetRunlessBudgetForTests();
  h.run.mockResolvedValue(null);
  persisted(0, 0);
  h.resolveSettings.mockResolvedValue({
    'workflow.runlessMaxInputTokens': 1000,
    'workflow.runlessMaxOutputTokens': 100,
  });
});

describe('recordRunlessUsage', () => {
  it('passes under the cap and fails BUDGET_EXCEEDED, carrying the attribution, over it', async () => {
    await expect(recordRunlessUsage('wf', 'r1', call(600, 10), 'l')).resolves.toBeUndefined();
    // Not persisted yet, so the first call still counts: 600 + 600 > 1000.
    const err = await recordRunlessUsage('wf', 'r1', call(600, 10), 'l').catch((e) => e);
    expect(err).toMatchObject({ nonRetryable: true, type: 'BUDGET_EXCEEDED' });
    expect(err.details[0].attribution).toEqual(call(600, 10));
  });

  it('counts persisted rows once: what an activity persisted leaves the in-process sum', async () => {
    await recordRunlessUsage('wf', 'r1', call(600, 10), 'l');
    takePersistingUsage('wf', 'r1', 600, 10);
    persisted(600, 10);
    // 600 persisted + 300 new = 900, under the cap. Without the subtraction it would be 1500.
    await expect(recordRunlessUsage('wf', 'r1', call(300, 10), 'l')).resolves.toBeUndefined();
  });

  it('puts back exactly what it took when the trace write fails', async () => {
    await recordRunlessUsage('wf', 'r1', call(600, 10), 'l');
    // Asks for more than this process holds: only the 600 it had is taken.
    const restore = takePersistingUsage('wf', 'r1', 900, 10);
    await expect(recordRunlessUsage('wf', 'r1', call(300, 10), 'l')).resolves.toBeUndefined();
    restore();
    // The write never landed: 600 + 300 back in the in-process sum, plus 200 > 1000.
    await expect(recordRunlessUsage('wf', 'r1', call(200, 10), 'l')).rejects.toMatchObject({
      type: 'BUDGET_EXCEEDED',
    });
  });

  it('restores nothing for an execution it holds nothing for', async () => {
    takePersistingUsage('wf', 'r1', 900, 10)();
    await expect(recordRunlessUsage('wf', 'r1', call(900, 10), 'l')).resolves.toBeUndefined();
  });

  it('scopes the sum to one execution of a reused workflow id', async () => {
    await recordRunlessUsage('wf', 'r1', call(900, 10), 'l');
    await expect(recordRunlessUsage('wf', 'r2', call(900, 10), 'l')).resolves.toBeUndefined();
    expect(h.aggregate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ temporalRunId: 'r2', workflowId: 'wf' }),
      })
    );
  });

  it('leaves a workflow with a run to its own budget', async () => {
    h.run.mockResolvedValue({ id: 'run-1' });
    await expect(recordRunlessUsage('wf', 'r1', call(5000, 500), 'l')).resolves.toBeUndefined();
    expect(h.aggregate).not.toHaveBeenCalled();
  });

  it('resolves the cap against the spend owner', async () => {
    await recordRunlessUsage('wf', 'r1', call(1, 1), 'l');
    expect(h.resolveSettings).toHaveBeenCalledWith(expect.any(Array), {
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  it('never fails a paid call when the budget cannot be read', async () => {
    h.aggregate.mockRejectedValue(new Error('db down'));
    await expect(recordRunlessUsage('wf', 'r1', call(5000, 500), 'l')).resolves.toBeUndefined();
  });

  it("still adds a call whose run lookup failed, so persisting it takes nothing from another arm's tokens", async () => {
    // Arm B's call is in flight, unpersisted.
    await recordRunlessUsage('wf', 'r1', call(500, 10), 'l');
    // Arm A's call: the run lookup fails, so the call is not capped...
    h.run.mockRejectedValueOnce(new Error('db blip'));
    await expect(recordRunlessUsage('wf', 'r1', call(400, 10), 'l')).resolves.toBeUndefined();
    // ...but arm A's trace write still subtracts its 400 tokens.
    takePersistingUsage('wf', 'r1', 400, 10);
    persisted(400, 10);
    // Arm B's 500 are still counted: 400 persisted + 500 in flight + 200 > 1000.
    await expect(recordRunlessUsage('wf', 'r1', call(200, 10), 'l')).rejects.toMatchObject({
      type: 'BUDGET_EXCEEDED',
    });
  });

  it('does nothing outside an activity', async () => {
    await expect(recordRunlessUsage('wf', null, call(5000, 500), 'l')).resolves.toBeUndefined();
    expect(h.run).not.toHaveBeenCalled();
  });
});

describe('assertRunlessBudgetAvailable', () => {
  it('refuses a call once the cap is reached, and allows one below it', async () => {
    persisted(999, 0);
    await expect(assertRunlessBudgetAvailable('wf', 'r1', 'l')).resolves.toBeUndefined();
    persisted(0, 100);
    await expect(assertRunlessBudgetAvailable('wf', 'r1', 'l')).rejects.toMatchObject({
      type: 'BUDGET_EXCEEDED',
    });
  });
});

describe('withRunlessCapScale', () => {
  it('multiplies the cap for calls made inside it, and only those', async () => {
    persisted(2500, 0);
    await expect(
      withRunlessCapScale(3, () => assertRunlessBudgetAvailable('wf', 'r1', 'l'))
    ).resolves.toBeUndefined();
    await expect(assertRunlessBudgetAvailable('wf', 'r1', 'l')).rejects.toMatchObject({
      type: 'BUDGET_EXCEEDED',
    });
  });

  it("never shrinks the cap below one execution's worth", async () => {
    persisted(999, 0);
    await expect(
      withRunlessCapScale(0, () => assertRunlessBudgetAvailable('wf', 'r1', 'l'))
    ).resolves.toBeUndefined();
  });
});
