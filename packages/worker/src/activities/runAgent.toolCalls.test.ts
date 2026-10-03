import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
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
vi.mock('../lib/usdCapGuard.js', () => ({ assertModelPricedForUsdCap: vi.fn(async () => {}) }));
vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: vi.fn(async () => ({
    costUsd: 0,
    inputTokens: 0,
    modelSpec: 'x/y',
    outputTokens: 0,
  })),
}));

import { AgentTracer } from '../lib/agentTracer.js';
import type { AgentSpec } from '../lib/config/agentSpec.js';
import { runAgent } from './runAgent.js';

/**
 * Drives the installed `@mastra/core` loop (not a mock of it) so the step shape
 * `runAgent` reads its tool outcomes from is pinned: if an upgrade moves where a
 * thrown tool's error lands, this fails instead of the failure being recorded
 * as a success with no output.
 */

const USAGE = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

/** Calls `boom` and `ok` in one step, then answers. */
function twoToolModel() {
  let calls = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      return calls === 1
        ? {
            content: [
              { input: '{}', toolCallId: 'c1', toolName: 'boom', type: 'tool-call' },
              { input: '{}', toolCallId: 'c2', toolName: 'ok', type: 'tool-call' },
            ],
            finishReason: { raw: 'tool_use', unified: 'tool-calls' },
            usage: USAGE,
            warnings: [],
          }
        : {
            content: [{ text: 'done', type: 'text' }],
            finishReason: { raw: 'stop', unified: 'stop' },
            usage: USAGE,
            warnings: [],
          };
    },
  } as never);
}

const boom = createTool({
  description: 'always throws',
  execute: async () => {
    throw new Error('kaboom');
  },
  id: 'boom',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

const ok = createTool({
  description: 'always succeeds',
  execute: async () => ({ v: 1 }),
  id: 'ok',
  inputSchema: z.object({}),
  outputSchema: z.object({ v: z.number() }),
});

function spec(): AgentSpec {
  return {
    agentKey: 'contentWriter',
    model: twoToolModel() as unknown as AgentSpec['model'],
    modelSpec: 'x/y',
    skills: [],
    systemPrompt: 'sys',
    tools: { boom, ok } as unknown as AgentSpec['tools'],
  };
}

describe('runAgent tool-call rows against the real Mastra loop', () => {
  it('records a tool that threw as an error carrying its message, not a success', async () => {
    const addToolCall = vi.spyOn(AgentTracer.prototype, 'addToolCall');

    const r = await runAgent(spec(), 'go');

    expect(r.text).toBe('done');
    const rows = addToolCall.mock.calls.map(([c]) => c);
    expect(rows).toEqual([
      expect.objectContaining({ error: 'kaboom', outputJson: undefined, toolName: 'boom' }),
      expect.objectContaining({ error: undefined, outputJson: { v: 1 }, toolName: 'ok' }),
    ]);
    addToolCall.mockRestore();
  });

  it("with a caller's tracer, records the tools that do not record themselves, once", async () => {
    const tracer = new AgentTracer();
    const s = spec();
    // `ok` stands in for an MCP/workspace tool: it records its own row as it runs.
    const selfRecordingOk = createTool({
      description: 'records itself',
      execute: async () => {
        tracer.addToolCall({ durationMs: 3, inputJson: {}, outputJson: { v: 1 }, toolName: 'ok' });
        return { v: 1 };
      },
      id: 'ok',
      inputSchema: z.object({}),
      outputSchema: z.object({ v: z.number() }),
    });
    s.tools = { boom, ok: selfRecordingOk } as unknown as AgentSpec['tools'];
    const addToolCall = vi.spyOn(tracer, 'addToolCall');

    await runAgent(s, 'go', { selfRecordingTools: new Set(['ok']), tracer });

    expect(addToolCall.mock.calls.map(([c]) => [c.toolName, c.error])).toEqual([
      ['ok', undefined],
      ['boom', 'kaboom'],
    ]);
  });
});
