import { beforeEach, describe, expect, it, vi } from 'vitest';

const { abortSignalOption, recordLlmUsage, recordSuspiciousLlmOutput } = vi.hoisted(() => ({
  abortSignalOption: vi.fn((): { abortSignal?: AbortSignal } => ({})),
  recordLlmUsage: vi.fn(),
  recordSuspiciousLlmOutput: vi.fn(async () => {}),
}));

vi.mock('../lib/activityContext.js', () => ({ currentWorkflowId: vi.fn(() => 'wf-1') }));
vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));
vi.mock('../lib/cancellation.js', () => ({ abortSignalOption }));
vi.mock('../lib/costTracking.js', () => ({ recordLlmUsage }));
vi.mock('../lib/llmOutputScan.js', () => ({ recordSuspiciousLlmOutput }));

import type { AgentTracer } from '../lib/agentTracer.js';
import {
  type ImplementerRuntime,
  mastraRuntime,
  runImplementerTurn,
  spentUsageOf,
  withSpentUsage,
} from './implementerRuntime.js';

const addLlmResponse = vi.fn();
const tracer = { addLlmResponse } as unknown as AgentTracer;

function turn(runtime: ImplementerRuntime, context?: Record<string, unknown>) {
  return {
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

    expect(runtime.runTurn).toHaveBeenCalledWith({ system: 'SYS', user: 'USER' });
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
    // The failure row stays the caller's.
    expect(addLlmResponse).not.toHaveBeenCalled();
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
