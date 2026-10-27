import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { ApplicationFailure } from '@temporalio/activity';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { assertBudgetAvailable, recordLlmUsage, logWarn } = vi.hoisted(() => ({
  assertBudgetAvailable: vi.fn(async (_label?: string) => {}),
  logWarn: vi.fn(),
  recordLlmUsage: vi.fn(),
}));
vi.mock('../lib/activityContext.js', () => ({ currentWorkflowId: vi.fn(() => 'wf-1') }));
vi.mock('../lib/activityLog.js', () => ({ logWarn }));
vi.mock('../lib/costTracking.js', () => ({ assertBudgetAvailable, recordLlmUsage }));
vi.mock('../lib/llmOutputScan.js', () => ({ recordSuspiciousLlmOutput: vi.fn(async () => {}) }));

import type { AgentTracer } from '../lib/agentTracer.js';
import { mastraRuntime, runImplementerTurn } from './implementerRuntime.js';

// The real Mastra loop, with a scripted model: what the fake `generate` in
// implementerRuntime.test.ts only imitates.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loopAgent(
  finishOnCall?: number,
  delays: { model?: number; tool?: number } = {},
  toolFinish = 'tool-calls'
) {
  let calls = 0;
  let toolRuns = 0;
  const slowPing = createTool({
    description: 'ping',
    execute: async () => {
      toolRuns += 1;
      await sleep(delays.tool ?? 0);
      return { ok: true };
    },
    id: 'ping',
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
  });
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      await sleep(delays.model ?? 0);
      const done = finishOnCall === calls;
      return {
        content: done
          ? [{ text: 'all done', type: 'text' }]
          : [{ input: '{}', toolCallId: `c${calls}`, toolName: 'ping', type: 'tool-call' }],
        finishReason: done
          ? { raw: 'stop', unified: 'stop' }
          : { raw: toolFinish, unified: toolFinish },
        usage: { inputTokens: { noCache: 10, total: 10 }, outputTokens: { text: 5, total: 5 } },
        warnings: [],
      };
    },
  } as never);
  const agent = new Agent({
    id: 'a',
    instructions: 'sys',
    model: model as never,
    name: 'a',
    tools: { ping: slowPing },
  });
  return { agent, calls: () => calls, toolRuns: () => toolRuns };
}

describe('mastraRuntime against the real Mastra loop', () => {
  it('stops the loop at the step whose debit throws and rethrows that error', async () => {
    const { agent, calls } = loopAgent();
    const failure = ApplicationFailure.nonRetryable('Budget exceeded', 'BUDGET_EXCEEDED');
    const debited: number[] = [];

    await expect(
      mastraRuntime(agent, 50).runTurn({
        onCallSpent: async (spent) => {
          debited.push(spent[0]?.usage.inputTokens ?? 0);
          if (debited.length === 3) {
            throw failure;
          }
        },
        system: 'S',
        user: 'U',
      })
    ).rejects.toBe(failure);

    expect(debited).toEqual([10, 10, 10]);
    expect(calls()).toBe(3);
  });

  it('reports nothing owed for a completed turn whose steps were all debited', async () => {
    const { agent } = loopAgent(3);
    const debited: number[] = [];

    const outcome = await mastraRuntime(agent, 50).runTurn({
      onCallSpent: async (spent) => {
        debited.push(spent[0]?.usage.inputTokens ?? 0);
      },
      system: 'S',
      user: 'U',
    });

    expect(debited).toEqual([10, 10, 10]);
    expect(outcome.text).toBe('all done');
    expect(outcome.usage).toBeUndefined();
  });
});

describe('a real Mastra turn with a slow debit', () => {
  const addLlmResponse = vi.fn();
  const tracer = { addLlmResponse } as unknown as AgentTracer;
  const ledger: { inputTokens: number }[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    ledger.length = 0;
    assertBudgetAvailable.mockImplementation(async () => {});
    // A debit that takes database time: Mastra does not wait for it before the next call.
    recordLlmUsage.mockImplementation(async (_wf, _role, usage: { inputTokens: number }) => {
      await sleep(50);
      ledger.push(usage);
      return { costUsd: 0.01, inputTokens: usage.inputTokens, modelSpec: 'x/y', outputTokens: 5 };
    });
  });

  const run = (agent: Agent) =>
    runImplementerTurn({
      agent: null,
      role: 'implementer',
      runtime: mastraRuntime(agent, 10),
      system: 'S',
      tracer,
      usageEvent: 'llm.implementer.test',
      user: 'U',
    });
  const ledgerInput = () => ledger.reduce((a, u) => a + u.inputTokens, 0);

  it('puts every step that ran on the ledger and on the one abort row', async () => {
    const { agent } = loopAgent(undefined, { model: 5, tool: 5 });
    const failure = ApplicationFailure.nonRetryable('Budget exceeded', 'BUDGET_EXCEEDED');
    assertBudgetAvailable.mockImplementation(async () => {
      if (recordLlmUsage.mock.calls.length >= 2) {
        throw failure;
      }
    });

    await expect(run(agent)).rejects.toBe(failure);

    // Steps that finished after the stop reached the ledger, not only the two debited
    // before it (a call cut off in flight is not counted, so the exact count varies).
    expect(ledger.length).toBeGreaterThan(2);
    expect(ledgerInput()).toBe(ledger.length * 10);
    expect(addLlmResponse).toHaveBeenCalledTimes(1);
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: ledgerInput(), outputTokens: ledger.length * 5 })
    );
  });

  it('checks no budget after the last step, but an over-cap debit still fails the turn', async () => {
    const { agent } = loopAgent(3, { model: 5 });
    const over = ApplicationFailure.nonRetryable('Budget exceeded', 'BUDGET_EXCEEDED');
    // The ledger throws as the tier goes over its cap, as `recordLlmUsage` does.
    const cap = 30;
    let used = 0;
    recordLlmUsage.mockImplementation(async (_wf, _role, usage: { inputTokens: number }) => {
      used += usage.inputTokens;
      ledger.push(usage);
      if (used > cap) {
        throw over;
      }
      return { costUsd: 0.01, inputTokens: usage.inputTokens, modelSpec: 'x/y', outputTokens: 5 };
    });

    // Exactly at the cap: the last step is debited and nothing follows it to guard.
    assertBudgetAvailable.mockImplementation(async () => {
      if (used >= cap) {
        throw over;
      }
    });
    const result = await run(agent);

    expect(result.text).toBe('all done');
    expect(ledgerInput()).toBe(30);
    // Only the two steps a call follows were checked.
    expect(assertBudgetAvailable).toHaveBeenCalledTimes(2);

    // One token over the cap on the last step fails the turn, as the end-of-turn debit did.
    used = 1;
    ledger.length = 0;
    await expect(run(loopAgent(3, { model: 5 }).agent)).rejects.toBe(over);
  });

  it('checks the budget after a step the model ended with `stop` but a tool call', async () => {
    // Ollama-style: Mastra runs the tool and continues, so a call follows each such step.
    const { agent, calls } = loopAgent(3, {}, 'stop');

    const result = await run(agent);

    expect(calls()).toBe(3);
    expect(result.text).toBe('all done');
    expect(assertBudgetAvailable).toHaveBeenCalledTimes(2);
  });
});
