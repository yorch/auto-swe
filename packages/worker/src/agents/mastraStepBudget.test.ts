import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Pins the Mastra behaviour the implementer's step budget depends on, against
 * the installed `@mastra/core` rather than a mock of it: `agent.generate`
 * stops a tool loop after 5 steps unless the call passes `maxSteps`, and a
 * passed `maxSteps` is the ceiling. If an upgrade renames the option or moves
 * the default, this fails instead of every implementer turn silently
 * shrinking (or growing) back to Mastra's default.
 */

const USAGE = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

/** A model that never stops asking for the tool — only the step budget ends the turn. */
function alwaysCallsTool(): MockLanguageModelV4 {
  let call = 0;
  const toolCall = () => ({
    input: '{}',
    toolCallId: `call-${++call}`,
    toolName: 'ping',
    type: 'tool-call' as const,
  });
  const finish = { raw: 'tool_use', unified: 'tool-calls' as const };
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [toolCall()],
      finishReason: finish,
      usage: USAGE,
      warnings: [],
    }),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          toolCall(),
          { finishReason: finish, type: 'finish' as const, usage: USAGE },
        ],
      }),
    }),
  });
}

async function modelCallsFor(options: Record<string, unknown>): Promise<number> {
  const model = alwaysCallsTool();
  const ping = createTool({
    description: 'ping',
    execute: async () => ({ ok: true }),
    id: 'ping',
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
  });
  const agent = new Agent({
    id: 'step-budget',
    instructions: 'call ping',
    model,
    name: 'step-budget',
    tools: { ping },
  });
  await agent.generate([{ content: 'go', role: 'user' }], { toolChoice: 'auto', ...options });
  return model.doStreamCalls.length + model.doGenerateCalls.length;
}

describe('Mastra agent step budget', () => {
  it('stops a tool loop after 5 steps when no budget is passed', async () => {
    await expect(modelCallsFor({})).resolves.toBe(5);
  });

  it('honours maxSteps as the ceiling', async () => {
    await expect(modelCallsFor({ maxSteps: 12 })).resolves.toBe(12);
  });
});
