import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Message } from '@mariozechner/pi-ai';
import { wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { reasoningMiddleware } from '../../lib/reasoning.js';
import {
  aiSdkStreamFn,
  piContentOf,
  piModelDescriptor,
  toModelMessages,
  usageTotals,
} from './model.js';

const usage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
};

describe('toModelMessages', () => {
  it("carries a conversation's text, tool calls and tool results, and unsigned thinking as plain reasoning", () => {
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
          { text: 'hmm', type: 'reasoning' },
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

describe('piContentOf', () => {
  it('keeps the parts in order with their provider metadata, and round-trips it', () => {
    const signed = { anthropic: { signature: 'sig-1' } };
    const content = piContentOf([
      { providerMetadata: signed, text: 'Let me look.', type: 'reasoning' },
      { text: 'Reading.', type: 'text' },
      {
        input: { path: '/r/a' },
        providerMetadata: { google: { thoughtSignature: 'ts' } },
        toolCallId: 't1',
        toolName: 'read',
        type: 'tool-call',
      },
      { providerMetadata: { anthropic: { redactedData: 'opaque' } }, text: '', type: 'reasoning' },
    ] as never);
    expect(content.map((c) => c.type)).toEqual(['thinking', 'text', 'toolCall', 'thinking']);
    expect(content[3]).toMatchObject({ redacted: true });
    const [assistant] = toModelMessages([
      {
        api: 'auto-swe',
        content,
        model: 'm',
        provider: 'p',
        role: 'assistant',
        stopReason: 'toolUse',
        timestamp: 0,
        usage,
      },
    ]);
    expect(assistant).toEqual({
      content: [
        { providerOptions: signed, text: 'Let me look.', type: 'reasoning' },
        { text: 'Reading.', type: 'text' },
        {
          input: { path: '/r/a' },
          providerOptions: { google: { thoughtSignature: 'ts' } },
          toolCallId: 't1',
          toolName: 'read',
          type: 'tool-call',
        },
        {
          providerOptions: { anthropic: { redactedData: 'opaque' } },
          text: '',
          type: 'reasoning',
        },
      ],
      role: 'assistant',
    });
  });

  it('ignores a signature it did not write', () => {
    const [assistant] = toModelMessages([
      {
        api: 'auto-swe',
        content: [{ thinking: 't', thinkingSignature: 'raw-signature', type: 'thinking' }],
        model: 'm',
        provider: 'p',
        role: 'assistant',
        stopReason: 'stop',
        timestamp: 0,
        usage,
      },
    ]);
    expect(assistant).toEqual({ content: [{ text: 't', type: 'reasoning' }], role: 'assistant' });
  });
});

describe('aiSdkStreamFn', () => {
  const MODEL_USAGE = {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
    outputTokens: { reasoning: 40, text: 10, total: 50 },
  };

  it('sends the first call’s signed reasoning back on the call after its tool call, with the Agent’s level', async () => {
    const calls: { prompt: unknown; reasoning: unknown }[] = [];
    let n = 0;
    const mock = new MockLanguageModelV4({
      doGenerate: async (options: { prompt: unknown; reasoning?: unknown }) => {
        calls.push({ prompt: options.prompt, reasoning: options.reasoning });
        n += 1;
        return n === 1
          ? {
              content: [
                {
                  providerMetadata: { anthropic: { signature: 'sig-1' } },
                  text: 'I should read the file.',
                  type: 'reasoning',
                },
                {
                  input: JSON.stringify({ path: '/r/a' }),
                  toolCallId: 'call-1',
                  toolName: 'read',
                  type: 'tool-call',
                },
              ],
              finishReason: { raw: 'tool_use', unified: 'tool-calls' },
              response: { id: 'msg-1' },
              usage: MODEL_USAGE,
              warnings: [],
            }
          : {
              content: [{ text: 'done', type: 'text' }],
              finishReason: { raw: 'end_turn', unified: 'stop' },
              response: { id: 'msg-2' },
              usage: MODEL_USAGE,
              warnings: [],
            };
      },
    } as never);
    const model = wrapLanguageModel({ middleware: reasoningMiddleware('high'), model: mock });
    const spent: number[] = [];
    const streamFn = aiSdkStreamFn(
      {
        heartbeat: () => {},
        model,
        onCall: ({ usage: u }) => spent.push(u.output),
        onError: () => {},
        spec: 'anthropic/claude-opus-5-5',
      },
      () =>
        [
          {
            description: 'Read a file',
            name: 'read',
            parameters: { properties: { path: { type: 'string' } }, type: 'object' },
          },
        ] as unknown as AgentTool[]
    );
    const descriptor = piModelDescriptor('anthropic/claude-opus-5-5');
    const history: Message[] = [{ content: 'fix it', role: 'user', timestamp: 0 }];

    const first = (await (
      await streamFn(descriptor, { messages: history, systemPrompt: 'S' })
    ).result()) as AssistantMessage;
    history.push(first, {
      content: [{ text: 'contents', type: 'text' }],
      isError: false,
      role: 'toolResult',
      timestamp: 0,
      toolCallId: 'call-1',
      toolName: 'read',
    });
    await (await streamFn(descriptor, { messages: history, systemPrompt: 'S' })).result();

    expect(calls.map((c) => c.reasoning)).toEqual(['high', 'high']);
    const secondPrompt = (calls[1]?.prompt ?? []) as { role: string; content: unknown }[];
    const assistantTurn = secondPrompt.find((m) => m.role === 'assistant');
    expect(assistantTurn?.content).toEqual([
      expect.objectContaining({
        providerOptions: { anthropic: { signature: 'sig-1' } },
        text: 'I should read the file.',
        type: 'reasoning',
      }),
      expect.objectContaining({ toolCallId: 'call-1', toolName: 'read', type: 'tool-call' }),
    ]);
    // Reasoning is output: both calls are metered at their whole output.
    expect(spent).toEqual([50, 50]);
  });
});

describe('usageTotals', () => {
  it('counts reasoning as output: the whole output total, not its text share', () => {
    expect(
      usageTotals({
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 10 },
        inputTokens: 10,
        outputTokenDetails: { reasoningTokens: 900, textTokens: 100 },
        outputTokens: 1000,
        totalTokens: 1010,
      }).output
    ).toBe(1000);
  });

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
