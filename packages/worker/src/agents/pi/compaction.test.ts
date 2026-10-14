import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { compactMessages, elisionStub, estimateTokens } from './compaction.js';

const user = (text: string): AgentMessage => ({ content: text, role: 'user', timestamp: 0 });
const assistant = (...calls: { id: string; name: string }[]): AgentMessage =>
  ({
    content: calls.length
      ? calls.map((c) => ({ arguments: { n: 1 }, id: c.id, name: c.name, type: 'toolCall' }))
      : [{ text: 'done', type: 'text' }],
    role: 'assistant',
    stopReason: calls.length ? 'toolUse' : 'stop',
    timestamp: 0,
  }) as unknown as AgentMessage;
const result = (id: string, name: string, text: string, isError = false): AgentMessage =>
  ({
    content: [{ text, type: 'text' }],
    details: { big: 'x'.repeat(100) },
    isError,
    role: 'toolResult',
    timestamp: 0,
    toolCallId: id,
    toolName: name,
  }) as unknown as AgentMessage;

const BIG = 'x'.repeat(4_000); // 1000 tokens

/** `exchanges` user prompts, each with `steps` tool calls returning BIG. */
function conversation(exchanges: number, steps: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let e = 0; e < exchanges; e++) {
    out.push(user(`prompt ${e} ${'z'.repeat(4_000)}`));
    for (let s = 0; s < steps; s++) {
      out.push(assistant({ id: `c${e}-${s}`, name: 'read' }), result(`c${e}-${s}`, 'read', BIG));
    }
    out.push(assistant());
  }
  return out;
}

/** The invariants every compacted conversation keeps. */
function expectWellFormed(messages: AgentMessage[]) {
  expect((messages[0] as { role: string }).role).toBe('user');
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of messages as unknown as {
    role: string;
    content: { type: string; id?: string }[];
    toolCallId?: string;
  }[]) {
    if (m.role === 'assistant') {
      for (const part of m.content) {
        if (part.type === 'toolCall') {
          calls.add(part.id as string);
        }
      }
    } else if (m.role === 'toolResult') {
      results.add(m.toolCallId as string);
    }
  }
  expect(results).toEqual(calls);
}

describe('estimateTokens', () => {
  it('counts the system prompt and every kind of message part', () => {
    expect(estimateTokens('', [])).toBe(0);
    expect(estimateTokens('x'.repeat(400), [])).toBe(100);
    expect(estimateTokens('', [user('x'.repeat(40)), result('a', 'read', 'y'.repeat(40))])).toBe(
      20
    );
    expect(estimateTokens('', [assistant({ id: 'a', name: 'read' })])).toBeGreaterThan(0);
  });
});

describe('compactMessages', () => {
  it('returns the same messages when under budget', () => {
    const messages = conversation(2, 2);
    const out = compactMessages({ budgetTokens: 1_000_000, messages, systemPrompt: 'sys' });
    expect(out.messages).toBe(messages);
    expect(out.elidedResults).toBe(0);
    expect(out.droppedMessages).toBe(0);
  });

  it('elides old tool results first, oldest first, keeping ids and error flags', () => {
    const messages = conversation(1, 8);
    messages[2] = result('c0-0', 'read', BIG, true);
    const total = estimateTokens('', messages);
    const out = compactMessages({ budgetTokens: total - 2_500, messages, systemPrompt: '' });

    expect(out.droppedMessages).toBe(0);
    expect(out.elidedResults).toBe(3);
    const results = out.messages.filter(
      (m) => (m as { role: string }).role === 'toolResult'
    ) as unknown as {
      content: { text: string }[];
      isError: boolean;
      toolCallId: string;
      toolName: string;
      details?: unknown;
    }[];
    expect(results.slice(0, 3).map((r) => r.content[0]?.text)).toEqual(
      Array(3).fill(elisionStub('read'))
    );
    expect(results[0]).toMatchObject({ isError: true, toolCallId: 'c0-0', toolName: 'read' });
    expect(results[0]?.details).toBeUndefined();
    expect(results[3]?.content[0]?.text).toBe(BIG);
    expect(out.afterTokens).toBeLessThanOrEqual(total - 2_500);
    expect(out.afterTokens).toBeLessThan(out.beforeTokens);
    expectWellFormed(out.messages);
  });

  it('never elides the results of the most recent assistant turns', () => {
    const messages = conversation(1, 6);
    const out = compactMessages({ budgetTokens: 1, messages, systemPrompt: '' });
    const results = out.messages.filter(
      (m) => (m as { role: string }).role === 'toolResult'
    ) as unknown as {
      content: { text: string }[];
    }[];
    // 6 calls + a final answer: the last 4 assistant turns are the last 3 calls and the answer.
    expect(results.filter((r) => r.content[0]?.text === BIG)).toHaveLength(3);
    expect(results.filter((r) => r.content[0]?.text !== BIG)).toHaveLength(3);
  });

  it('drops the oldest whole exchanges when eliding is not enough, keeping the current prompt', () => {
    const messages = conversation(5, 2);
    const budget = 4_500;
    const out = compactMessages({ budgetTokens: budget, messages, systemPrompt: '' });

    expect(out.droppedMessages).toBeGreaterThan(0);
    expect(out.afterTokens).toBeLessThanOrEqual(budget);
    expect(out.messages.at(-1)).toBe(messages.at(-1));
    expect(JSON.stringify(out.messages)).toContain('prompt 4');
    expect(JSON.stringify(out.messages)).not.toContain('prompt 0');
    // What survives is a suffix of whole exchanges: it begins at a user message.
    expectWellFormed(out.messages);
  });

  it('sends the newest exchange even when it alone exceeds the budget', () => {
    const messages = conversation(3, 6);
    const out = compactMessages({ budgetTokens: 10, messages, systemPrompt: 'sys' });
    expect(out.messages[0]).toBe(
      [...messages].reverse().find((m) => (m as { role: string }).role === 'user')
    );
    expect(out.afterTokens).toBeGreaterThan(10);
    expectWellFormed(out.messages);
  });

  it('does not modify its input', () => {
    const messages = conversation(4, 4);
    const copy = JSON.stringify(messages);
    compactMessages({ budgetTokens: 100, messages, systemPrompt: '' });
    expect(JSON.stringify(messages)).toBe(copy);
  });

  it('is stable when applied again', () => {
    const messages = conversation(4, 4);
    const once = compactMessages({ budgetTokens: 3_000, messages, systemPrompt: '' });
    const twice = compactMessages({
      budgetTokens: 3_000,
      messages: once.messages,
      systemPrompt: '',
    });
    expect(twice.messages).toEqual(once.messages);
    expect(twice.elidedResults).toBe(0);
  });
});
