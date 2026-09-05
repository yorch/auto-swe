import { describe, expect, it, vi } from 'vitest';
import { type HitlResolveDeps, resolveHitlStep } from './hitlResolve.js';

/**
 * Value validation is the one chokepoint between a human's answer (inbox or
 * Slack) and the Temporal signal the interpreter routes on. A DECISION value
 * outside the configured options must never reach the workflow — the
 * interpreter treats it as a malformed signal and fails the run.
 */

const ADMIN = { role: 'ADMIN', sub: 'user-1' };

function makeDeps(step: Record<string, unknown>) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const signalWorkflow = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    autonomyDecision: {
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    workflowHumanStep: {
      findFirst: vi.fn().mockResolvedValue(step),
      updateMany,
    },
  };
  const deps = {
    log: { error: vi.fn(), warn: vi.fn() },
    // The resolve core wraps its writes in an interactive transaction; hand
    // the callback the same fake so the assertions see the calls.
    prisma: Object.assign(prisma, {
      $transaction: async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    }),
    temporal: { signalWorkflow },
  } as unknown as HitlResolveDeps;
  return { deps, signalWorkflow, updateMany };
}

const decisionStep = {
  fields: null,
  id: 'step-1',
  kind: 'DECISION',
  options: [
    { label: 'Ship it', value: 'ship' },
    { label: 'Abort', value: 'abort' },
  ],
  requiredApprovers: 1,
  run: { id: 'run-1', status: 'RUNNING', workflowId: 'wf-1' },
  signalName: 'hitl_pick',
  status: 'PENDING',
  title: 'Ship?',
};

describe('resolveHitlStep — DECISION value validation', () => {
  it('rejects a value that is not one of the configured options without touching the row', async () => {
    const { deps, signalWorkflow, updateMany } = makeDeps(decisionStep);
    const result = await resolveHitlStep(deps, 'step-1', 'select', 'not-an-option', ADMIN);
    expect(result).toMatchObject({ code: 'INVALID_VALUE', ok: false });
    expect((result as { message: string }).message).toMatch(/not one of the configured options/);
    expect(updateMany).not.toHaveBeenCalled();
    expect(signalWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a non-string value', async () => {
    const { deps, signalWorkflow } = makeDeps(decisionStep);
    const result = await resolveHitlStep(deps, 'step-1', 'select', { value: 'ship' }, ADMIN);
    expect(result).toMatchObject({ code: 'INVALID_VALUE', ok: false });
    expect(signalWorkflow).not.toHaveBeenCalled();
  });

  it('resolves and signals when the value is one of the options', async () => {
    const { deps, signalWorkflow, updateMany } = makeDeps(decisionStep);
    const result = await resolveHitlStep(deps, 'step-1', 'select', 'abort', ADMIN);
    expect(result).toMatchObject({ ok: true, signalSent: true, status: 'RESOLVED' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(signalWorkflow).toHaveBeenCalledWith('wf-1', 'hitl_pick', [
      { action: 'select', resolvedBy: 'user-1', value: 'abort' },
    ]);
  });
});
