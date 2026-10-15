import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One assistant turn end to end inside the worker: the real tools, the real `runAgent` and Mastra
 * loop, and the docs the worker image ships, with only the model scripted and the database mocked.
 * The model asks `searchDocs` how to configure an integration and answers by citing the section
 * the tool returned, which is the shape a real answer must have (`docs/adr/in-app-assistant.md`
 * D11 item 2).
 */

const db = vi.hoisted(() => ({
  assistantConversation: { update: vi.fn() },
  assistantMessage: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const model = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn().mockResolvedValue(6) }));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('../lib/activityLog.js', () => ({ logError: vi.fn() }));
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: () => 'assistant-conv-1',
  persistActivityTrace: vi.fn().mockResolvedValue(true),
}));
vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: vi
    .fn()
    .mockResolvedValue({ costUsd: 0, inputTokens: 0, modelSpec: 'mock/m', outputTokens: 0 }),
}));
vi.mock('../lib/usdCapGuard.js', () => ({ assertModelPricedForUsdCap: vi.fn(async () => {}) }));
vi.mock('../lib/spendOwner.js', () => ({
  ownerOfUser: vi.fn().mockResolvedValue({}),
  withSpendOwner: (_owner: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn(async (input: { availableTools: unknown }) => ({
    agentKey: 'appAssistant',
    model: model.current,
    modelSpec: 'mock/model',
    skills: [],
    systemPrompt: 'You are the assistant.',
    tools: input.availableTools,
  })),
}));

import { persistActivityTrace } from '../lib/activityContext.js';
import { runAssistantTurn } from './assistantTurn.js';

const USAGE = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

/** The first `/docs/...` link in the tool results the model was shown. */
function firstDocLink(prompt: unknown): string | undefined {
  return JSON.stringify(prompt).match(/\/docs\/[A-Za-z0-9-]+(?:#[a-z0-9-]+)?/)?.[0];
}

/** Step 1 searches the docs; step 2 answers from what came back, citing it. */
function scriptedModel(): MockLanguageModelV4 {
  let step = 0;
  const answer = (prompt: unknown) =>
    `Configure it under Studio → Integrations → GitHub. See [the docs](${firstDocLink(prompt) ?? '(no link)'}).`;
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      step += 1;
      return step === 1
        ? {
            content: [
              {
                input: JSON.stringify({ query: 'github app' }),
                toolCallId: 'call-1',
                toolName: 'searchDocs',
                type: 'tool-call' as const,
              },
            ],
            finishReason: { raw: 'tool_use', unified: 'tool-calls' as const },
            usage: USAGE,
            warnings: [],
          }
        : {
            content: [{ text: answer(prompt), type: 'text' as const }],
            finishReason: { raw: 'end_turn', unified: 'stop' as const },
            usage: USAGE,
            warnings: [],
          };
    },
    doStream: async ({ prompt }) => {
      step += 1;
      if (step === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              {
                input: JSON.stringify({ query: 'github app' }),
                toolCallId: 'call-1',
                toolName: 'searchDocs',
                type: 'tool-call' as const,
              },
              {
                finishReason: { raw: 'tool_use', unified: 'tool-calls' as const },
                type: 'finish' as const,
                usage: USAGE,
              },
            ],
          }),
        };
      }
      const text = answer(prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { id: 't1', type: 'text-start' as const },
            { delta: text.slice(0, 20), id: 't1', type: 'text-delta' as const },
            { delta: text.slice(20), id: 't1', type: 'text-delta' as const },
            { id: 't1', type: 'text-end' as const },
            {
              finishReason: { raw: 'end_turn', unified: 'stop' as const },
              type: 'finish' as const,
              usage: USAGE,
            },
          ],
        }),
      };
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  model.current = scriptedModel();
  db.assistantMessage.findFirst.mockResolvedValue({
    createdAt: new Date('2026-10-14T10:00:00Z'),
    id: 'reply-1',
    status: 'PENDING',
  });
  db.assistantMessage.findMany.mockResolvedValue([
    {
      content: 'How do I configure the GitHub integration?',
      pageContext: { route: '/studio/integrations' },
      role: 'USER',
      status: 'COMPLETE',
    },
  ]);
  db.assistantMessage.update.mockResolvedValue({});
  db.assistantMessage.updateMany.mockResolvedValue({ count: 1 });
  db.assistantConversation.update.mockResolvedValue({});
});

describe('an assistant turn, end to end in the worker', () => {
  it('answers a configuration question with a cited /docs section', async () => {
    expect(
      await runAssistantTurn({
        conversationId: 'conv-1',
        replyId: 'reply-1',
        token: 'asst_test',
        userId: 'user-1',
      })
    ).toEqual({ status: 'COMPLETE' });

    const final = db.assistantMessage.update.mock.calls.at(-1)?.[0].data;
    expect(final.status).toBe('COMPLETE');
    expect(final.content).toMatch(/\[the docs\]\(\/docs\/[A-Za-z0-9-]+(#[a-z0-9-]+)?\)/);
    expect(final.steps).toEqual([expect.objectContaining({ status: 'done', tool: 'searchDocs' })]);
    expect(final.steps[0].summary).toMatch(/doc section/);
    // The model was streamed, so the panel sees the reply as it is written.
    const m = model.current as MockLanguageModelV4;
    expect(m.doStreamCalls).toHaveLength(2);
    expect(m.doGenerateCalls).toHaveLength(0);
    // The turn's trace was written, in runAgent's finally.
    expect(persistActivityTrace).toHaveBeenCalledWith(expect.anything(), 'appAssistant');
    // Builds the docs index over every shipped doc, which takes seconds on a loaded CI runner.
  }, 60_000);
});
