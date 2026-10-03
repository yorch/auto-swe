import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

const generateMock = vi.fn();
vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(function (this: Record<string, unknown>, config: unknown) {
    this.config = config;
    this.generate = generateMock;
  }),
}));

// A recording tracer: the real API is a no-op without an SDK, and its spans all
// carry the same all-zero context, which cannot show *which* span was captured.
vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_name: string, fn: (span: unknown) => unknown) =>
        fn({
          end: vi.fn(),
          recordException: vi.fn(),
          setAttribute: vi.fn(),
          spanContext: () => ({ spanId: 'llm-span', traceId: 'llm-trace' }),
        }),
    }),
  },
}));

vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: vi.fn().mockReturnValue('wf-1'),
  persistActivityTrace: vi.fn().mockResolvedValue(undefined),
}));

const { resolveSettingMock } = vi.hoisted(() => ({ resolveSettingMock: vi.fn(async () => 50) }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: resolveSettingMock }));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({ teamId: 'team-from-activity' })),
}));

vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: vi
    .fn()
    .mockResolvedValue({ costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 }),
}));

const { assertPricedMock } = vi.hoisted(() => ({ assertPricedMock: vi.fn(async () => {}) }));
vi.mock('../lib/usdCapGuard.js', () => ({ assertModelPricedForUsdCap: assertPricedMock }));

import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import type { AgentSpec } from '../lib/config/agentSpec.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { runAgent } from './runAgent.js';

const mockedRecordUsage = vi.mocked(recordLlmUsage);
const mockedPersist = vi.mocked(persistActivityTrace);
const MockedAgent = vi.mocked(Agent);

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    agentKey: 'validateContext',
    model: { sentinel: 'model' } as unknown as AgentSpec['model'],
    modelSpec: 'anthropic/claude-x',
    skills: [],
    systemPrompt: 'SYS',
    tools: {} as AgentSpec['tools'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runAgent', () => {
  it('refuses to call the model when it is unpriced under a USD cap', async () => {
    assertPricedMock.mockRejectedValueOnce(new Error('MODEL_UNPRICED'));
    await expect(runAgent(makeSpec(), 'USER_MSG')).rejects.toThrow('MODEL_UNPRICED');
    expect(generateMock).not.toHaveBeenCalled();
    expect(mockedRecordUsage).not.toHaveBeenCalled();
  });

  it('checks the bound model against the channel scope it was given', async () => {
    generateMock.mockResolvedValue({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });
    await runAgent(makeSpec(), 'USER_MSG', { ctx: { channelId: 'chan-1' } });
    expect(assertPricedMock).toHaveBeenCalledWith('anthropic/claude-x', { channelId: 'chan-1' });
  });

  it('builds the agent from the spec and returns structured output', async () => {
    const schema = z.object({ successCriteria: z.array(z.string()) });
    generateMock.mockResolvedValue({
      object: { successCriteria: ['a', 'b'] },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const result = await runAgent(makeSpec({ outputSchema: schema }), 'USER_MSG', {
      spanName: 'llm.context_validation',
    });

    expect(result.object).toEqual({ successCriteria: ['a', 'b'] });
    // Agent constructed with the spec's model, prompt, and tools.
    expect(MockedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'validateContext',
        instructions: 'SYS',
        model: { sentinel: 'model' },
        name: 'validateContext',
      })
    );
    // Structured output requested with the spec's schema.
    expect(generateMock).toHaveBeenCalledWith([{ content: 'USER_MSG', role: 'user' }], {
      structuredOutput: { schema },
    });
  });

  it('records usage under the agent key and span name', async () => {
    generateMock.mockResolvedValue({
      object: { ok: true },
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    await runAgent(makeSpec(), 'M', { spanName: 'llm.context_validation' });

    expect(mockedRecordUsage).toHaveBeenCalledWith(
      'wf-1',
      'validateContext',
      { inputTokens: 1, outputTokens: 2 },
      'llm.context_validation',
      // Priced at the model the call was bound to, not re-resolved from ambient context.
      'anthropic/claude-x'
    );
  });

  it('reports an unpriced model to the caller, so a cap can still count the call', async () => {
    generateMock.mockResolvedValue({
      object: { ok: true },
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    mockedRecordUsage.mockResolvedValueOnce({
      costUsd: 0,
      inputTokens: 1,
      modelSpec: 'x/unpriced',
      outputTokens: 2,
      pricingKnown: false,
    });

    const result = await runAgent(makeSpec(), 'M');

    expect(result.costUsd).toBe(0);
    expect(result.pricingKnown).toBe(false);
  });

  it('skips usage recording when the provider reports none', async () => {
    generateMock.mockResolvedValue({ object: { ok: true } });
    await runAgent(makeSpec(), 'M');
    expect(mockedRecordUsage).not.toHaveBeenCalled();
  });

  it('returns free text when the spec has no output schema', async () => {
    generateMock.mockResolvedValue({ text: 'hello world' });
    const result = await runAgent(makeSpec(), 'M');
    expect(result.text).toBe('hello world');
    expect(result.object).toBeUndefined();
    // No schema → plain generate call (no structuredOutput option).
    expect(generateMock).toHaveBeenCalledWith([{ content: 'M', role: 'user' }]);
  });

  it('persists the trace even when generate throws, then rethrows', async () => {
    generateMock.mockRejectedValue(new Error('LLM down'));

    await expect(runAgent(makeSpec(), 'M')).rejects.toThrow('LLM down');
    expect(mockedPersist).toHaveBeenCalledWith(expect.anything(), 'validateContext');
  });

  it('persists the trace on the success path', async () => {
    generateMock.mockResolvedValue({ object: { ok: true } });
    await runAgent(makeSpec(), 'M');
    expect(mockedPersist).toHaveBeenCalledWith(expect.anything(), 'validateContext');
  });

  it('attaches its own LLM span to the trace, since it persists after that span ends', async () => {
    generateMock.mockResolvedValue({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });
    const setSpanContext = vi.spyOn(AgentTracer.prototype, 'setSpanContext');

    await runAgent(makeSpec(), 'USER_MSG');

    expect(setSpanContext).toHaveBeenCalledWith('llm-trace', 'llm-span');
    // ...and before persisting, so persistActivityTrace sees it already set.
    const tracer = mockedPersist.mock.calls[0]?.[0] as AgentTracer;
    expect(tracer.hasSpanContext()).toBe(true);
    setSpanContext.mockRestore();
  });

  it('gives a tool-bearing agent the workspace.agentMaxSteps budget at the caller scope', async () => {
    generateMock.mockResolvedValue({ text: 'done' });
    resolveSettingMock.mockResolvedValueOnce(77);
    const tools = { mcp_search: {} } as unknown as AgentSpec['tools'];
    const ctx = { channelId: 'C1', teamId: 'team-1' };

    await runAgent(makeSpec({ tools }), 'M', { ctx });

    expect(resolveSettingMock).toHaveBeenCalledWith('workspace.agentMaxSteps', ctx);
    expect(generateMock).toHaveBeenCalledWith([{ content: 'M', role: 'user' }], {
      maxSteps: 77,
    });
  });

  it('falls back to the activity request context when the caller passes none', async () => {
    generateMock.mockResolvedValue({ text: 'done' });
    const tools = { mcp_search: {} } as unknown as AgentSpec['tools'];
    await runAgent(makeSpec({ tools }), 'M');
    expect(resolveSettingMock).toHaveBeenCalledWith('workspace.agentMaxSteps', {
      teamId: 'team-from-activity',
    });
  });

  it("records each tool call of the loop as a tool_call row, before the call's llm_response", async () => {
    // The step shape Mastra 1.73 returns: a tool that threw is absent from
    // `toolResults` (its `tool-error` chunk is never buffered there) and from
    // `content`; its message survives only in the cumulative tool message.
    const toolMessage = {
      content: [
        { output: { type: 'json', value: { found: 1 } }, toolCallId: 'c1', type: 'tool-result' },
        { output: { type: 'error-text', value: 'boom' }, toolCallId: 'c2', type: 'tool-result' },
      ],
      role: 'tool',
    };
    generateMock.mockResolvedValue({
      steps: [
        {
          content: [
            { toolCallId: 'c1', type: 'tool-call' },
            { toolCallId: 'c1', type: 'tool-result' },
            { error: new Error('durable boom'), toolCallId: 'c3', type: 'tool-error' },
          ],
          response: { messages: [{ content: [], role: 'assistant' }, toolMessage] },
          toolCalls: [
            { payload: { args: { q: 'a' }, toolCallId: 'c1', toolName: 'delegateTask' } },
            { payload: { args: { q: 'b' }, toolCallId: 'c2', toolName: 'search' } },
            { payload: { args: { q: 'c' }, toolCallId: 'c3', toolName: 'search' } },
            { payload: { args: { q: 'd' }, toolCallId: 'c4', toolName: 'search' } },
          ],
          toolResults: [{ payload: { result: { found: 1 }, toolCallId: 'c1' } }],
        },
        {
          content: [{ text: 'done', type: 'text' }],
          response: { messages: [toolMessage] },
          text: 'done',
          toolCalls: [],
          toolResults: [],
        },
      ],
      text: 'done',
    });
    const addToolCall = vi.spyOn(AgentTracer.prototype, 'addToolCall');
    const addLlmResponse = vi.spyOn(AgentTracer.prototype, 'addLlmResponse');

    await runAgent(makeSpec(), 'M');

    expect(addToolCall.mock.calls.map(([c]) => c)).toEqual([
      {
        durationMs: 0,
        error: undefined,
        inputJson: { q: 'a' },
        outputJson: { found: 1 },
        toolName: 'delegateTask',
      },
      {
        durationMs: 0,
        error: 'boom',
        inputJson: { q: 'b' },
        outputJson: undefined,
        toolName: 'search',
      },
      {
        durationMs: 0,
        error: 'durable boom',
        inputJson: { q: 'c' },
        outputJson: undefined,
        toolName: 'search',
      },
      {
        durationMs: 0,
        error: 'tool call produced no result (it threw or did not complete)',
        inputJson: { q: 'd' },
        outputJson: undefined,
        toolName: 'search',
      },
    ]);
    expect(addToolCall.mock.invocationCallOrder.at(-1)).toBeLessThan(
      addLlmResponse.mock.invocationCallOrder[0] as number
    );
    addToolCall.mockRestore();
    addLlmResponse.mockRestore();
  });

  it("records into a caller's tracer, leaves persisting to it, and does not re-record its tools", async () => {
    generateMock.mockResolvedValue({
      steps: [
        {
          toolCalls: [{ payload: { args: {}, toolCallId: 'c1', toolName: 'mcp_search' } }],
          toolResults: [{ payload: { result: {}, toolCallId: 'c1' } }],
        },
      ],
      text: 'done',
    });
    const tracer = new AgentTracer();
    // What the MCP wrapper records while the loop runs.
    tracer.addToolCall({ durationMs: 5, inputJson: {}, toolName: 'mcp:search' });
    const addToolCall = vi.spyOn(tracer, 'addToolCall');

    await runAgent(makeSpec(), 'M', { tracer });

    expect(mockedPersist).not.toHaveBeenCalled();
    expect(addToolCall).not.toHaveBeenCalled();
    // The MCP row and the loop's response, numbered in one sequence.
    expect(tracer.size).toBe(2);
  });

  it('does not read the step budget for a tool-free agent', async () => {
    generateMock.mockResolvedValue({ text: 'x' });
    await runAgent(makeSpec(), 'M');
    expect(resolveSettingMock).not.toHaveBeenCalled();
  });
});
