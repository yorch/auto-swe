import { createTool } from '@mastra/core/tools';
import { ApplicationFailure } from '@temporalio/activity';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: vi.fn().mockReturnValue('wf-1'),
  persistActivityTrace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn(async () => 50) }));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({})),
}));

const { cancel } = vi.hoisted(() => ({ cancel: { controller: new AbortController() } }));
vi.mock('../lib/cancellation.js', () => ({
  abortSignalOption: () => ({ abortSignal: cancel.controller.signal }),
  activityCancellationSignal: () => cancel.controller.signal,
}));

const { ledger } = vi.hoisted(() => ({
  ledger: {
    budgetCalls: 0,
    recorded: [] as number[],
    stopAfterBudgetChecks: Number.POSITIVE_INFINITY,
  },
}));
vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {
    ledger.budgetCalls += 1;
    if (ledger.budgetCalls > ledger.stopAfterBudgetChecks) {
      throw ApplicationFailure.nonRetryable('Budget already exhausted', 'BUDGET_EXCEEDED');
    }
  }),
  recordLlmUsage: vi.fn(async (_wf: string, _role: string, usage: { inputTokens?: number }) => {
    ledger.recorded.push(usage.inputTokens ?? 0);
    return {
      costUsd: 0.01,
      inputTokens: usage.inputTokens ?? 0,
      modelSpec: 'x/y',
      outputTokens: 5,
    };
  }),
}));

import type { AgentSpec } from '../lib/config/agentSpec.js';
import { runAgent } from './runAgent.js';

const ping = createTool({
  description: 'ping',
  execute: async () => ({ ok: true }),
  id: 'ping',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
});

interface ModelOpts {
  delayMs?: number;
  failOnCall?: number;
  /** Return a final text answer on this call instead of another tool call. */
  finishOnCall?: number;
}

function toolLoopModel(opts: ModelOpts = {}) {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (opts.failOnCall === calls) {
        throw new Error('provider exploded');
      }
      const done = opts.finishOnCall === calls;
      return {
        content: done
          ? [{ text: 'all done', type: 'text' }]
          : [{ input: '{}', toolCallId: `c${calls}`, toolName: 'ping', type: 'tool-call' }],
        finishReason: done
          ? { raw: 'stop', unified: 'stop' }
          : { raw: 'tool-calls', unified: 'tool-calls' },
        usage: {
          inputTokens: { noCache: 10, total: 10 },
          outputTokens: { text: 5, total: 5 },
        },
        warnings: [],
      };
    },
  } as never);
  return { callCount: () => calls, model };
}

function specFor(model: unknown): AgentSpec {
  return {
    agentKey: 'contentWriter',
    model: model as AgentSpec['model'],
    modelSpec: 'x/y',
    skills: [],
    systemPrompt: 'sys',
    tools: { ping } as unknown as AgentSpec['tools'],
  };
}

beforeEach(() => {
  ledger.budgetCalls = 0;
  ledger.recorded = [];
  ledger.stopAfterBudgetChecks = Number.POSITIVE_INFINITY;
  cancel.controller = new AbortController();
});

describe('runAgent per-step accounting', () => {
  it('records each step as it finishes, once, and does not re-debit the total', async () => {
    const { model } = toolLoopModel({ finishOnCall: 3 });
    const r = await runAgent(specFor(model), 'go', { perStepAccounting: true });
    expect(r.text).toBe('all done');
    expect(r.stepCount).toBe(3);
    // 3 steps, 3 debits of 10 input tokens each; never a fourth, summed one.
    expect(ledger.recorded).toEqual([10, 10, 10]);
    expect(r.inputTokens).toBe(30);
    expect(r.stoppedReason).toBeUndefined();
  });

  it('reports max_steps when the loop used every step', async () => {
    const { model } = toolLoopModel();
    const r = await runAgent(specFor(model), 'go', { maxSteps: 3, perStepAccounting: true });
    expect(r.stoppedReason).toBe('max_steps');
    expect(ledger.recorded).toHaveLength(3);
  });

  it('records the spend of completed steps when the wall-clock deadline aborts the call', async () => {
    const { model } = toolLoopModel({ delayMs: 60 });
    const deadline = AbortSignal.timeout(250);
    const r = await runAgent(specFor(model), 'go', {
      abortSignal: deadline,
      perStepAccounting: true,
    });
    expect(r.stoppedReason).toBe('wall_clock');
    // The old shape returned here with nothing debited.
    expect(ledger.recorded.length).toBeGreaterThanOrEqual(1);
    expect(r.inputTokens).toBe(ledger.recorded.reduce((a, b) => a + b, 0));
  });

  it('stops a loop whose budget runs out part-way, with BUDGET_EXCEEDED, long before the step cap', async () => {
    ledger.stopAfterBudgetChecks = 3; // 1 pre-call + 2 per-step checks pass, the 3rd step fails
    const { model, callCount } = toolLoopModel();
    await expect(runAgent(specFor(model), 'go', { perStepAccounting: true })).rejects.toMatchObject(
      { type: 'BUDGET_EXCEEDED' }
    );
    expect(callCount()).toBeLessThan(10);
    // Every step that ran was still debited.
    expect(ledger.recorded.length).toBe(callCount());
  });

  it('keeps the spend of earlier steps when the provider fails mid-loop', async () => {
    const { model } = toolLoopModel({ failOnCall: 3 });
    await expect(runAgent(specFor(model), 'go', { perStepAccounting: true })).rejects.toThrow();
    expect(ledger.recorded).toEqual([10, 10]);
  });

  it('treats cancellation as a failure, not a partial result', async () => {
    const { model } = toolLoopModel({ delayMs: 40 });
    setTimeout(() => cancel.controller.abort(new Error('cancelled')), 100);
    await expect(runAgent(specFor(model), 'go', { perStepAccounting: true })).rejects.toThrow();
    expect(ledger.recorded.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the old single-record behaviour when the option is off', async () => {
    const { model } = toolLoopModel({ finishOnCall: 3 });
    const r = await runAgent(specFor(model), 'go', {});
    expect(r.text).toBe('all done');
    // One debit of the summed usage, as before.
    expect(ledger.recorded).toEqual([30]);
  });
});
