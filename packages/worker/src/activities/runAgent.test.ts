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

vi.mock('../lib/costTracking.js', () => ({ recordLlmUsage: vi.fn().mockResolvedValue(undefined) }));

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
});
