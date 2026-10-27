import { beforeEach, describe, expect, it, vi } from 'vitest';

const { abortSignalOption, assertBudgetAvailable, recordLlmUsage, recordSuspiciousLlmOutput } =
  vi.hoisted(() => ({
    abortSignalOption: vi.fn((): { abortSignal?: AbortSignal } => ({})),
    assertBudgetAvailable: vi.fn(async (_label?: string) => {}),
    recordLlmUsage: vi.fn(),
    recordSuspiciousLlmOutput: vi.fn(async () => {}),
  }));

vi.mock('../lib/activityContext.js', () => ({ currentWorkflowId: vi.fn(() => 'wf-1') }));
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('../lib/activityLog.js', () => ({ logWarn }));
vi.mock('../lib/cancellation.js', () => ({ abortSignalOption }));
vi.mock('../lib/costTracking.js', () => ({ assertBudgetAvailable, recordLlmUsage }));
vi.mock('../lib/llmOutputScan.js', () => ({ recordSuspiciousLlmOutput }));

import { ApplicationFailure } from '@temporalio/activity';
import type { AgentTracer } from '../lib/agentTracer.js';
import {
  type ImplementerRuntime,
  mastraRuntime,
  perCallAccounting,
  runImplementerTurn,
  spentUsageOf,
  wasTurnTraced,
  withSpentUsage,
} from './implementerRuntime.js';

const addLlmResponse = vi.fn();
const tracer = { addLlmResponse } as unknown as AgentTracer;

function turn(runtime: ImplementerRuntime, context?: Record<string, unknown>) {
  return {
    agent: { id: 'agent-row-1', version: 4 },
    context,
    role: 'implementer',
    runtime,
    system: 'SYS',
    tracer,
    usageEvent: 'llm.implementer.iteration_0',
    user: 'USER',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recordLlmUsage.mockResolvedValue({
    costUsd: 0.5,
    inputTokens: 10,
    modelSpec: 'anthropic/claude-opus-5-5',
    outputTokens: 4,
  });
});

describe('runImplementerTurn', () => {
  it('accrues usage, scans the output and records the call with the caller context', async () => {
    const runtime: ImplementerRuntime = {
      runTurn: vi.fn(async () => ({
        text: 'done',
        toolCallCount: 3,
        usage: { inputTokens: 10, outputTokens: 4 },
      })),
    };

    const result = await runImplementerTurn(turn(runtime, { iteration: 2 }));

    expect(runtime.runTurn).toHaveBeenCalledWith({
      onCallSpent: expect.any(Function),
      system: 'SYS',
      user: 'USER',
    });
    expect(recordLlmUsage).toHaveBeenCalledWith(
      'wf-1',
      'implementer',
      { inputTokens: 10, outputTokens: 4 },
      'llm.implementer.iteration_0',
      undefined
    );
    expect(recordSuspiciousLlmOutput).toHaveBeenCalledWith(tracer, 'done', {
      inputJson: { iteration: 2 },
    });
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        costUsd: 0.5,
        inputJson: { iteration: 2, systemPrompt: 'SYS', userMessage: 'USER' },
        inputTokens: 10,
        model: 'anthropic/claude-opus-5-5',
        outputJson: { text: 'done' },
        outputTokens: 4,
        role: 'implementer',
      })
    );
    // The turn's Agent row rides on the row, so a version's spend can be read back.
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ agent: { id: 'agent-row-1', version: 4 } })
    );
    expect(result.text).toBe('done');
    expect(result.attribution.costUsd).toBe(0.5);
  });

  it('prices the call at the bound model spec when the caller names one', async () => {
    const runtime: ImplementerRuntime = {
      runTurn: async () => ({
        text: 'x',
        toolCallCount: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    await runImplementerTurn({ ...turn(runtime), boundModelSpec: 'openai/gpt-6-luna' });

    expect(recordLlmUsage).toHaveBeenCalledWith(
      'wf-1',
      'implementer',
      { inputTokens: 1, outputTokens: 1 },
      'llm.implementer.iteration_0',
      'openai/gpt-6-luna'
    );
  });

  it('prices each model a turn spent on at its own spec and records one combined call', async () => {
    recordLlmUsage
      .mockResolvedValueOnce({
        costUsd: 0.5,
        inputTokens: 1000,
        modelSpec: 'anthropic/claude-opus-5-5',
        outputTokens: 40,
        pricingKnown: true,
      })
      .mockResolvedValueOnce({
        costUsd: 0.01,
        inputTokens: 10,
        modelSpec: 'anthropic/claude-haiku-4-5-20251001',
        outputTokens: 5,
        pricingKnown: false,
      });
    const runtime: ImplementerRuntime = {
      runTurn: async () => ({
        text: 'ok',
        toolCallCount: 2,
        // Ignored once the split is given.
        usage: { inputTokens: 999, outputTokens: 999 },
        usageByModel: [
          {
            modelSpec: 'anthropic/claude-opus-5-5',
            usage: { inputTokens: 1000, outputTokens: 40 },
          },
          {
            modelSpec: 'anthropic/claude-haiku-4-5-20251001',
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        ],
      }),
    };

    const { attribution } = await runImplementerTurn({
      ...turn(runtime),
      boundModelSpec: 'openai/ignored',
    });

    expect(recordLlmUsage).toHaveBeenCalledTimes(2);
    expect(recordLlmUsage.mock.calls[0]?.[4]).toBe('anthropic/claude-opus-5-5');
    expect(recordLlmUsage.mock.calls[1]?.[4]).toBe('anthropic/claude-haiku-4-5-20251001');
    // The call row carries the total, attributed to the model that spent the most.
    expect(attribution).toEqual({
      costUsd: 0.51,
      inputTokens: 1010,
      modelSpec: 'anthropic/claude-opus-5-5',
      outputTokens: 45,
      pricingKnown: false,
    });
    expect(addLlmResponse).toHaveBeenCalledTimes(1);
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        costUsd: 0.51,
        inputTokens: 1010,
        model: 'anthropic/claude-opus-5-5',
        outputTokens: 45,
      })
    );
  });

  it('records nothing against the ledger when a harness turn spent no tokens', async () => {
    const runtime: ImplementerRuntime = {
      runTurn: async () => ({ text: 'ok', toolCallCount: 0, usageByModel: [] }),
    };
    const { attribution } = await runImplementerTurn(turn(runtime));
    expect(recordLlmUsage).not.toHaveBeenCalled();
    expect(attribution.costUsd).toBe(0);
  });

  it('still records the call when the model only made tool calls', async () => {
    const runtime: ImplementerRuntime = {
      runTurn: async () => ({ toolCallCount: 7, usage: { inputTokens: 1, outputTokens: 1 } }),
    };

    await runImplementerTurn(turn(runtime));

    expect(recordSuspiciousLlmOutput).toHaveBeenCalledWith(tracer, '', { inputJson: undefined });
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ outputJson: { toolCallCount: 7 } })
    );
  });

  it('records a zero attribution, without touching the ledger, when the runtime reports no usage', async () => {
    const runtime: ImplementerRuntime = { runTurn: async () => ({ text: 'x', toolCallCount: 0 }) };

    const result = await runImplementerTurn(turn(runtime));

    expect(recordLlmUsage).not.toHaveBeenCalled();
    expect(result.attribution).toEqual({
      costUsd: 0,
      inputTokens: 0,
      modelSpec: '',
      outputTokens: 0,
    });
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 0, model: undefined })
    );
  });

  it('records no call row and accrues nothing when the runtime throws a plain error', async () => {
    const runtime: ImplementerRuntime = {
      runTurn: async () => {
        throw new Error('provider 529');
      },
    };

    await expect(runImplementerTurn(turn(runtime))).rejects.toThrow('provider 529');

    expect(recordLlmUsage).not.toHaveBeenCalled();
    expect(addLlmResponse).not.toHaveBeenCalled();
  });

  it('accrues what a failed turn spent when the error carries it, and rethrows that same error', async () => {
    const failure = withSpentUsage(new Error('Claude Code ended with error_during_execution'), [
      { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 300, outputTokens: 60 } },
    ]);
    const runtime: ImplementerRuntime = {
      runTurn: async () => {
        throw failure;
      },
    };

    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);

    expect(recordLlmUsage).toHaveBeenCalledWith(
      'wf-1',
      'implementer',
      { inputTokens: 300, outputTokens: 60 },
      'llm.implementer.iteration_0',
      'anthropic/claude-opus-5-5'
    );
    // The aborted turn's one row carries what it spent and the error.
    expect(addLlmResponse).toHaveBeenCalledTimes(1);
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: { id: 'agent-row-1', version: 4 },
        costUsd: 0.5,
        error: 'Error: Claude Code ended with error_during_execution',
        inputTokens: 10,
        model: 'anthropic/claude-opus-5-5',
        outputTokens: 4,
        role: 'implementer',
      })
    );
  });

  it('rethrows the runtime’s error even when accruing its usage fails', async () => {
    recordLlmUsage.mockRejectedValue(new Error('BUDGET_EXCEEDED'));
    const failure = withSpentUsage(new Error('harness failed'), [
      { modelSpec: 'anthropic/m', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const runtime: ImplementerRuntime = {
      runTurn: async () => {
        throw failure;
      },
    };
    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);
  });

  it('propagates a budget failure from the usage ledger before the call row is written', async () => {
    recordLlmUsage.mockRejectedValue(new Error('BUDGET_EXCEEDED'));
    const runtime: ImplementerRuntime = {
      runTurn: async () => ({
        text: 'x',
        toolCallCount: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    await expect(runImplementerTurn(turn(runtime))).rejects.toThrow('BUDGET_EXCEEDED');

    expect(addLlmResponse).not.toHaveBeenCalled();
  });
});

describe('perCallAccounting', () => {
  const call = (input: number, output: number) => [
    { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: input, outputTokens: output } },
  ];

  it('debits each call to the ledger, then re-checks the budget, keeping a running total', async () => {
    const order: string[] = [];
    recordLlmUsage.mockImplementation(async () => {
      order.push('record');
      return {
        costUsd: 0.25,
        inputTokens: 10,
        modelSpec: 'anthropic/claude-opus-5-5',
        outputTokens: 2,
      };
    });
    assertBudgetAvailable.mockImplementation(async () => {
      order.push('check');
    });
    const accounting = perCallAccounting({ role: 'contentWriter', usageEvent: 'llm.agent_run' });

    await accounting.onCallSpent(call(10, 2));
    await accounting.onCallSpent(call(10, 2));

    expect(order).toEqual(['record', 'check', 'record', 'check']);
    expect(recordLlmUsage).toHaveBeenCalledWith(
      'wf-1',
      'contentWriter',
      { inputTokens: 10, outputTokens: 2 },
      'llm.agent_run',
      'anthropic/claude-opus-5-5'
    );
    expect(assertBudgetAvailable).toHaveBeenCalledWith('agent.contentWriter');
    expect(accounting.debited()).toEqual({
      costUsd: 0.5,
      inputTokens: 20,
      modelSpec: 'anthropic/claude-opus-5-5',
      outputTokens: 4,
    });
  });

  it('throws the budget failure after recording the call that exhausted it', async () => {
    const budget = new Error('BUDGET_EXCEEDED');
    assertBudgetAvailable.mockRejectedValueOnce(budget);
    const accounting = perCallAccounting({ role: 'r', usageEvent: 'e' });
    await expect(accounting.onCallSpent(call(10, 2))).rejects.toBe(budget);
    expect(recordLlmUsage).toHaveBeenCalledTimes(1);
    expect(accounting.debited().costUsd).toBe(0.5);
  });

  it('meters every turn per call: the row covers what was debited and what the turn still owed', async () => {
    const runtime: ImplementerRuntime = {
      runTurn: async ({ onCallSpent }) => {
        // The runtime hands over a finished call while the turn runs…
        await onCallSpent?.([
          { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 100, outputTokens: 40 } },
        ]);
        // …and reports only what it did not hand over.
        return {
          text: 'done',
          toolCallCount: 1,
          usageByModel: [
            { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 10, outputTokens: 4 } },
          ],
        };
      },
    };

    const { attribution } = await runImplementerTurn(turn(runtime));

    // The debited call, then the remainder; the budget is re-checked after the debit.
    expect(recordLlmUsage).toHaveBeenCalledTimes(2);
    expect(assertBudgetAvailable).toHaveBeenCalledWith('agent.implementer');
    expect(attribution).toEqual({
      costUsd: 1,
      inputTokens: 20,
      modelSpec: 'anthropic/claude-opus-5-5',
      outputTokens: 8,
    });
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 1, inputTokens: 20, outputTokens: 8 })
    );
  });

  it('fails the turn with the budget error a per-call debit raised', async () => {
    const budget = new Error('BUDGET_EXCEEDED');
    assertBudgetAvailable.mockRejectedValueOnce(budget);
    const runtime: ImplementerRuntime = {
      runTurn: async ({ onCallSpent }) => {
        await onCallSpent?.([
          { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
        return { toolCallCount: 0 };
      },
    };
    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(budget);
    expect(addLlmResponse).toHaveBeenCalledTimes(1);
  });

  it('records one row with the summed per-call usage when the turn aborts after N calls', async () => {
    const budget = new Error('BUDGET_EXCEEDED: run is over its tier');
    assertBudgetAvailable
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(budget);
    const runtime: ImplementerRuntime = {
      runTurn: async ({ onCallSpent }) => {
        for (let i = 0; i < 3; i++) {
          await onCallSpent?.([
            { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        return { toolCallCount: 0 };
      },
    };

    await expect(runImplementerTurn(turn(runtime, { iteration: 1 }))).rejects.toBe(budget);

    expect(addLlmResponse).toHaveBeenCalledTimes(1);
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        costUsd: 1.5,
        error: 'Error: BUDGET_EXCEEDED: run is over its tier',
        inputJson: { iteration: 1, systemPrompt: 'SYS', userMessage: 'USER' },
        inputTokens: 30,
        model: 'anthropic/claude-opus-5-5',
        outputTokens: 12,
      })
    );
  });

  it('adds the debited calls and the remainder an error carries into one row', async () => {
    const failure = new Error('cancelled');
    const runtime: ImplementerRuntime = {
      runTurn: async ({ onCallSpent }) => {
        await onCallSpent?.([
          { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
        throw withSpentUsage(failure, [
          { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      },
    };

    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);

    expect(addLlmResponse).toHaveBeenCalledTimes(1);
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 1, inputTokens: 20, outputTokens: 8 })
    );
  });

  it('trims the error text and keeps the stack out of it', async () => {
    const failure = new TypeError('x'.repeat(5000));
    const runtime: ImplementerRuntime = {
      runTurn: async ({ onCallSpent }) => {
        await onCallSpent?.([
          { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
        throw failure;
      },
    };

    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);

    const { error } = addLlmResponse.mock.calls[0][0] as { error: string };
    expect(error).toHaveLength(1000);
    expect(error.startsWith('TypeError: xxx')).toBe(true);
  });

  it('records nothing for an abort before any model call returned', async () => {
    const failure = new Error('aborted early');
    const runtime: ImplementerRuntime = {
      runTurn: async () => {
        throw failure;
      },
    };
    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);
    expect(addLlmResponse).not.toHaveBeenCalled();
  });

  it('rethrows the original error when the tracer throws while recording the abort', async () => {
    addLlmResponse.mockImplementationOnce(() => {
      throw new Error('tracer broke');
    });
    const failure = new Error('provider 500');
    const runtime: ImplementerRuntime = {
      runTurn: async ({ onCallSpent }) => {
        await onCallSpent?.([
          { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
        throw failure;
      },
    };
    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);
  });

  it('still records the debited usage when accruing the error remainder fails', async () => {
    const failure = withSpentUsage(new Error('harness failed'), [
      { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const runtime: ImplementerRuntime = {
      runTurn: async ({ onCallSpent }) => {
        await onCallSpent?.([
          { modelSpec: 'anthropic/claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
        throw failure;
      },
    };
    recordLlmUsage.mockResolvedValueOnce({
      costUsd: 0.5,
      inputTokens: 10,
      modelSpec: 'anthropic/claude-opus-5-5',
      outputTokens: 4,
    });
    recordLlmUsage.mockRejectedValueOnce(new Error('ledger down'));

    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);

    expect(addLlmResponse).toHaveBeenCalledTimes(1);
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 0.5, inputTokens: 10 })
    );
  });

  it('records exactly one row on the success path', async () => {
    const runtime: ImplementerRuntime = {
      runTurn: async () => ({
        text: 'ok',
        toolCallCount: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    await runImplementerTurn(turn(runtime));
    expect(addLlmResponse).toHaveBeenCalledTimes(1);
    expect(addLlmResponse.mock.calls[0][0]).not.toHaveProperty('error');
  });
});

describe('withSpentUsage', () => {
  it('marks an error without changing it, and ignores an empty spend', () => {
    const err = new Error('x');
    expect(withSpentUsage(err, [])).toBe(err);
    expect(spentUsageOf(err)).toBeUndefined();
    const spent = [{ modelSpec: 'anthropic/m', usage: { inputTokens: 1, outputTokens: 1 } }];
    expect(withSpentUsage(err, spent)).toBe(err);
    expect(spentUsageOf(err)).toBe(spent);
    expect(spentUsageOf('not an error')).toBeUndefined();
  });
});

describe('mastraRuntime', () => {
  it('generates with the step budget and maps the result', async () => {
    const generate = vi.fn(async () => ({
      // Tool calls, not model steps: three calls over two steps, plus a final text-only step.
      steps: [{ toolCalls: [{}, {}] }, { toolCalls: [{}] }, { toolCalls: [] }],
      text: 'ok',
      usage: { inputTokens: 5, outputTokens: 6 },
    }));

    const outcome = await mastraRuntime({ generate } as never, 42).runTurn({
      system: 'SYS',
      user: 'USER',
    });

    expect(generate).toHaveBeenCalledWith(
      [
        { content: 'SYS', role: 'system' },
        { content: 'USER', role: 'user' },
      ],
      { maxSteps: 42, toolChoice: 'auto' }
    );
    expect(outcome).toEqual({
      text: 'ok',
      toolCallCount: 3,
      usage: { inputTokens: 5, outputTokens: 6 },
    });
  });

  it("forwards the activity's abort signal so a cancelled run stops the tool loop", async () => {
    const signal = new AbortController().signal;
    abortSignalOption.mockReturnValue({ abortSignal: signal });
    const generate = vi.fn(async (..._args: unknown[]) => ({}));

    const outcome = await mastraRuntime({ generate } as never, 1).runTurn({
      system: 'S',
      user: 'U',
    });

    expect(generate.mock.calls[0]?.[1]).toMatchObject({ abortSignal: signal });
    expect(outcome.toolCallCount).toBe(0);
  });
});

describe('a Mastra turn whose end-of-turn debit trips the budget', () => {
  // The Mastra loop reports a turn's usage when it ends, so this is where its budget stop
  // lands: the ledger is debited, then the debit throws BUDGET_EXCEEDED carrying that call.
  const attribution = {
    costUsd: 2.26,
    inputTokens: 900_000,
    modelSpec: 'anthropic/claude-opus-5-5',
    outputTokens: 40_000,
  };
  const budget = () =>
    ApplicationFailure.nonRetryable('Budget exceeded for tier STANDARD', 'BUDGET_EXCEEDED', {
      attribution,
    });
  const agent = (usage: { inputTokens: number; outputTokens: number }) => ({
    generate: vi.fn(async () => ({
      steps: Array.from({ length: 50 }, () => ({ toolCalls: [{}] })),
      text: '',
      usage,
    })),
  });

  it('records one row with the usage the failing debit carried, and rethrows the error', async () => {
    const failure = budget();
    recordLlmUsage.mockRejectedValue(failure);
    const runtime = mastraRuntime(
      agent({ inputTokens: 900_000, outputTokens: 40_000 }) as unknown as Parameters<
        typeof mastraRuntime
      >[0],
      50
    );

    await expect(runImplementerTurn(turn(runtime, { iteration: 3 }))).rejects.toBe(failure);

    expect(addLlmResponse).toHaveBeenCalledTimes(1);
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: { id: 'agent-row-1', version: 4 },
        costUsd: 2.26,
        error: expect.stringContaining('Budget exceeded for tier STANDARD'),
        inputJson: { iteration: 3, systemPrompt: 'SYS', userMessage: 'USER' },
        inputTokens: 900_000,
        model: 'anthropic/claude-opus-5-5',
        outputTokens: 40_000,
        role: 'implementer',
      })
    );
  });

  it('keeps the models already debited when a later model trips the budget', async () => {
    const failure = budget();
    recordLlmUsage.mockResolvedValueOnce({
      costUsd: 0.5,
      inputTokens: 10,
      modelSpec: 'anthropic/claude-haiku-4-5-20251001',
      outputTokens: 4,
    });
    recordLlmUsage.mockRejectedValueOnce(failure);
    const runtime: ImplementerRuntime = {
      runTurn: async () => ({
        toolCallCount: 0,
        usageByModel: [
          {
            modelSpec: 'anthropic/claude-haiku-4-5-20251001',
            usage: { inputTokens: 10, outputTokens: 4 },
          },
          {
            modelSpec: 'anthropic/claude-opus-5-5',
            usage: { inputTokens: 900_000, outputTokens: 40_000 },
          },
        ],
      }),
    };

    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);

    expect(addLlmResponse).toHaveBeenCalledTimes(1);
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 2.76, inputTokens: 900_010, outputTokens: 40_004 })
    );
  });

  it('records one row, with no error, when the turn completes', async () => {
    const runtime = mastraRuntime(
      agent({ inputTokens: 10, outputTokens: 4 }) as unknown as Parameters<typeof mastraRuntime>[0],
      50
    );
    await runImplementerTurn(turn(runtime));
    expect(addLlmResponse).toHaveBeenCalledTimes(1);
    expect(addLlmResponse.mock.calls[0][0]).not.toHaveProperty('error');
  });

  it('records nothing when generate throws before any usage is reported', async () => {
    const failure = new Error('provider 529');
    const runtime = mastraRuntime(
      { generate: vi.fn(async () => Promise.reject(failure)) } as unknown as Parameters<
        typeof mastraRuntime
      >[0],
      50
    );
    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);
    expect(recordLlmUsage).not.toHaveBeenCalled();
    expect(addLlmResponse).not.toHaveBeenCalled();
  });
});

describe('wasTurnTraced and the failed-turn warning', () => {
  const budget = () =>
    ApplicationFailure.nonRetryable('over', 'BUDGET_EXCEEDED', {
      attribution: { costUsd: 1, inputTokens: 1, modelSpec: 'anthropic/m', outputTokens: 1 },
    });

  it('marks the error it traced, and no other', async () => {
    const failure = budget();
    recordLlmUsage.mockRejectedValue(failure);
    const runtime: ImplementerRuntime = {
      runTurn: async () => ({
        toolCallCount: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);
    expect(wasTurnTraced(failure)).toBe(true);
    expect(wasTurnTraced(budget())).toBe(false);
    expect(wasTurnTraced('boom')).toBe(false);
    expect(wasTurnTraced(undefined)).toBe(false);
  });

  it('does not mark an error when nothing was recorded for it', async () => {
    const failure = new Error('early');
    const runtime: ImplementerRuntime = {
      runTurn: async () => {
        throw failure;
      },
    };
    await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);
    expect(wasTurnTraced(failure)).toBe(false);
  });

  it('does not warn when charging the remainder trips the budget again, but does for anything else', async () => {
    const owed = [{ modelSpec: 'anthropic/m', usage: { inputTokens: 1, outputTokens: 1 } }];
    const run = async (secondary: Error) => {
      recordLlmUsage.mockRejectedValueOnce(secondary);
      const failure = withSpentUsage(budget(), owed);
      const runtime: ImplementerRuntime = {
        runTurn: async () => {
          throw failure;
        },
      };
      await expect(runImplementerTurn(turn(runtime))).rejects.toBe(failure);
    };
    await run(budget());
    expect(logWarn).not.toHaveBeenCalled();
    await run(new Error('ledger down'));
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});
