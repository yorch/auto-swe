import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

const generateMock = vi.fn();
vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(function (this: Record<string, unknown>, config: unknown) {
    this.config = config;
    this.generate = generateMock;
  }),
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

import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
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
      'llm.context_validation'
    );
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

  it('does not read the step budget for a tool-free agent', async () => {
    generateMock.mockResolvedValue({ text: 'x' });
    await runAgent(makeSpec(), 'M');
    expect(resolveSettingMock).not.toHaveBeenCalled();
  });
});
