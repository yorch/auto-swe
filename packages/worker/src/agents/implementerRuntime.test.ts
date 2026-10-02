import { beforeEach, describe, expect, it, vi } from 'vitest';

const { abortSignalOption, recordLlmUsage, recordSuspiciousLlmOutput } = vi.hoisted(() => ({
  abortSignalOption: vi.fn((): { abortSignal?: AbortSignal } => ({})),
  recordLlmUsage: vi.fn(),
  recordSuspiciousLlmOutput: vi.fn(async () => {}),
}));

vi.mock('../lib/activityContext.js', () => ({ currentWorkflowId: vi.fn(() => 'wf-1') }));
vi.mock('../lib/cancellation.js', () => ({ abortSignalOption }));
vi.mock('../lib/costTracking.js', () => ({ recordLlmUsage }));
vi.mock('../lib/llmOutputScan.js', () => ({ recordSuspiciousLlmOutput }));

import type { AgentTracer } from '../lib/agentTracer.js';
import {
  type ImplementerRuntime,
  mastraRuntime,
  runImplementerTurn,
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

  it('records no call row and accrues nothing when the runtime throws', async () => {
    const runtime: ImplementerRuntime = {
      runTurn: async () => {
        throw new Error('provider 529');
      },
    };

    await expect(runImplementerTurn(turn(runtime))).rejects.toThrow('provider 529');

    expect(recordLlmUsage).not.toHaveBeenCalled();
    expect(addLlmResponse).not.toHaveBeenCalled();
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

describe('mastraRuntime', () => {
  it('generates with the step budget and maps the result', async () => {
    const generate = vi.fn(async () => ({
      steps: [{}, {}],
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
      toolCallCount: 2,
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
