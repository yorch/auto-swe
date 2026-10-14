import type { Message } from '@mariozechner/pi-ai';
import { describe, expect, it } from 'vitest';
import { piModelDescriptor, toModelMessages, usageTotals } from './model.js';

const usage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
};

describe('toModelMessages', () => {
  it("carries a conversation's text, tool calls and tool results, and drops thinking", () => {
    const messages: Message[] = [
      { content: 'fix it', role: 'user', timestamp: 0 },
      {
        api: 'auto-swe',
        content: [
          { thinking: 'hmm', type: 'thinking' },
          { text: 'Looking.', type: 'text' },
          { arguments: { path: '/r/a' }, id: 't1', name: 'read', type: 'toolCall' },
        ],
        model: 'm',
        provider: 'p',
        role: 'assistant',
        stopReason: 'toolUse',
        timestamp: 0,
        usage,
      },
      {
        content: [{ text: 'boom', type: 'text' }],
        isError: true,
        role: 'toolResult',
        timestamp: 0,
        toolCallId: 't1',
        toolName: 'read',
      },
    ];
    expect(toModelMessages(messages)).toEqual([
      { content: 'fix it', role: 'user' },
      {
        content: [
          { text: 'Looking.', type: 'text' },
          { input: { path: '/r/a' }, toolCallId: 't1', toolName: 'read', type: 'tool-call' },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            output: { type: 'error-text', value: 'boom' },
            toolCallId: 't1',
            toolName: 'read',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      },
    ]);
  });
});

describe('usageTotals', () => {
  it('splits cache traffic from fresh input', () => {
    expect(
      usageTotals({
        inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 5, noCacheTokens: 65 },
        inputTokens: 100,
        outputTokenDetails: { reasoningTokens: 0, textTokens: 7 },
        outputTokens: 7,
        totalTokens: 107,
      })
    ).toEqual({ cacheRead: 30, cacheWrite: 5, input: 65, output: 7 });
  });

  it('derives fresh input when the provider reports only the total', () => {
    expect(
      usageTotals({
        inputTokenDetails: {
          cacheReadTokens: 10,
          cacheWriteTokens: undefined,
          noCacheTokens: undefined,
        },
        inputTokens: 50,
        outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
        outputTokens: undefined,
        totalTokens: undefined,
      })
    ).toEqual({ cacheRead: 10, cacheWrite: 0, input: 40, output: 0 });
  });
});

describe('piModelDescriptor', () => {
  it('names the provider and model of the spec', () => {
    expect(piModelDescriptor('openrouter/meta/llama-4')).toMatchObject({
      id: 'meta/llama-4',
      provider: 'openrouter',
    });
  });
});
