import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, it } from 'vitest';
import {
  ARG_STUB,
  compactMessages,
  createCompactor,
  elisionStub,
  estimateTokens,
  toolDefinitionChars,
} from './compaction.js';

const user = (text: string): AgentMessage => ({ content: text, role: 'user', timestamp: 0 });
const assistant = (...calls: { id: string; name: string; args?: object }[]): AgentMessage =>
  ({
    content: calls.length
      ? calls.map((c) => ({
          arguments: c.args ?? { n: 1 },
          id: c.id,
          name: c.name,
          type: 'toolCall',
        }))
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

const BIG = 'x'.repeat(4_000); // about 1333 tokens

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

const roleOf = (m: AgentMessage) => (m as { role: string }).role;
const resultsOf = (messages: AgentMessage[]) =>
  messages.filter((m) => roleOf(m) === 'toolResult') as unknown as {
    content: { text: string }[];
    isError: boolean;
    toolCallId: string;
    toolName: string;
    details?: unknown;
  }[];
const isWhole = (r: { content: { text: string }[] }) => r.content[0]?.text.length === 4_000;

/** The invariants every compacted conversation keeps. */
function expectWellFormed(messages: AgentMessage[]) {
  expect(roleOf(messages[0] as AgentMessage)).toBe('user');
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
  it('counts the system prompt, the tool definitions and every kind of message part', () => {
    expect(estimateTokens('', [])).toBe(0);
    expect(estimateTokens('x'.repeat(300), [])).toBe(100);
    expect(estimateTokens('', [], 300)).toBe(100);
    expect(estimateTokens('', [user('x'.repeat(30)), result('a', 'read', 'y'.repeat(30))])).toBe(
      20
    );
    expect(estimateTokens('', [assistant({ id: 'a', name: 'read' })])).toBeGreaterThan(0);
    expect(toolDefinitionChars([{ description: 'abc', name: 'ab', parameters: {} }])).toBe(7);
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

  it('counts the tool definitions against the budget', () => {
    const messages = conversation(1, 1);
    const total = estimateTokens('', messages);
    expect(compactMessages({ budgetTokens: total, messages, systemPrompt: '' }).messages).toBe(
      messages
    );
    const out = compactMessages({
      budgetTokens: total,
      messages,
      overheadChars: 3_000,
      systemPrompt: '',
    });
    expect(out.beforeTokens).toBe(total + 1_000);
  });

  it('elides tool results oldest first inside a single exchange, keeping ids and error flags', () => {
    const messages = conversation(1, 8);
    messages[2] = result('c0-0', 'read', BIG, true);
    const budget = estimateTokens('', messages) - 2_500;
    const out = compactMessages({
      budgetTokens: budget,
      messages,
      systemPrompt: '',
      targetRatio: 1,
    });

    expect(out.droppedMessages).toBe(0);
    expect(out.elidedResults).toBe(2);
    const results = resultsOf(out.messages);
    expect(results.slice(0, 2).map((r) => r.content[0]?.text)).toEqual(
      Array(2).fill(elisionStub('read'))
    );
    expect(results[0]).toMatchObject({ isError: true, toolCallId: 'c0-0', toolName: 'read' });
    expect(results[0]?.details).toBeUndefined();
    expect(isWhole(results[2] as never)).toBe(true);
    expect(out.afterTokens).toBeLessThanOrEqual(budget);
    expectWellFormed(out.messages);
  });

  it('spares the recent assistant turns, then the last call, until nothing else is left', () => {
    const messages = conversation(1, 6);
    const total = estimateTokens('', messages);
    // Room is made by the three results older than the four recent turns alone.
    const spared = compactMessages({
      budgetTokens: total - 3_800,
      messages,
      systemPrompt: '',
      targetRatio: 1,
    });
    expect(resultsOf(spared.messages).filter(isWhole)).toHaveLength(3);
    // Then everything but the last call and its result.
    const tight = compactMessages({
      budgetTokens: 3_500,
      messages,
      systemPrompt: '',
      targetRatio: 1,
    });
    const results = resultsOf(tight.messages);
    expect(results.filter(isWhole)).toHaveLength(1);
    expect(isWhole(results.at(-1) as never)).toBe(true);
    expectWellFormed(tight.messages);
    // The last result goes only when the budget cannot be met without it.
    const last = compactMessages({ budgetTokens: 1, messages, systemPrompt: '' });
    // Never the newest result, however far over budget.
    expect(resultsOf(last.messages).filter(isWhole)).toHaveLength(1);
    expect(isWhole(resultsOf(last.messages).at(-1) as never)).toBe(true);
    expectWellFormed(last.messages);
  });

  it('elides inside a session with fewer than four assistant turns, the last result last', () => {
    const messages: AgentMessage[] = [
      user('go'),
      assistant({ id: 'a', name: 'read' }),
      result('a', 'read', BIG),
      assistant({ id: 'b', name: 'read' }),
      result('b', 'read', BIG),
    ];
    const out = compactMessages({
      budgetTokens: 1_600,
      messages,
      systemPrompt: '',
      targetRatio: 1,
    });
    expect(out.elidedResults).toBe(1);
    expect(resultsOf(out.messages).map(isWhole)).toEqual([false, true]);
    expect(out.afterTokens).toBeLessThanOrEqual(1_600);
    const lastResort = compactMessages({ budgetTokens: 100, messages, systemPrompt: '' });
    expect(resultsOf(lastResort.messages).map(isWhole)).toEqual([false, true]);
    expectWellFormed(lastResort.messages);
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
    expectWellFormed(out.messages);
  });

  it('sends the newest exchange even when it alone exceeds the budget', () => {
    const messages = conversation(3, 6);
    const out = compactMessages({ budgetTokens: 10, messages, systemPrompt: 'sys' });
    expect(out.messages[0]).toBe([...messages].reverse().find((m) => roleOf(m) === 'user'));
    expect(out.afterTokens).toBeGreaterThan(10);
    expectWellFormed(out.messages);
  });

  it('does not modify its input', () => {
    const messages = conversation(4, 4);
    const copy = JSON.stringify(messages);
    compactMessages({ budgetTokens: 100, messages, systemPrompt: '' });
    expect(JSON.stringify(messages)).toBe(copy);
  });

  it('lets the newest result through whole however big the prompt is', () => {
    const messages: AgentMessage[] = [user('p'.repeat(330_000))];
    for (let k = 0; k < 3; k++) {
      messages.push(
        assistant({ id: `d${k}`, name: 'bash' }),
        result(`d${k}`, 'bash', 'y'.repeat(20_000))
      );
      const out = compactMessages({
        budgetTokens: 120_000,
        messages,
        systemPrompt: 'z'.repeat(20_000),
      });
      expect(
        (resultsOf(out.messages).at(-1) as { content: { text: string }[] }).content[0]?.text
      ).toBe('y'.repeat(20_000));
      expectWellFormed(out.messages);
    }
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

  it('spends an old exchange before the current one: old bulk goes first, current output stays', () => {
    const old: AgentMessage[] = [
      user('old'),
      assistant({ args: { content: 'w'.repeat(400_000), path: 'a.ts' }, id: 'w', name: 'write' }),
      result('w', 'write', 'ok'),
      assistant(),
    ];
    const current: AgentMessage[] = [user('now')];
    for (let k = 0; k < 6; k++) {
      current.push(
        assistant({ id: `n${k}`, name: 'bash' }),
        result(`n${k}`, 'bash', 'y'.repeat(20_000))
      );
    }
    const out = compactMessages({
      budgetTokens: 120_000,
      messages: [...old, ...current],
      systemPrompt: 'z'.repeat(20_000),
    });
    expect(out.afterTokens).toBeLessThanOrEqual(120_000);
    expect(out.elidedArguments).toBe(1);
    expect(out.droppedMessages).toBe(0);
    expect(out.elidedResults).toBe(0);
    expect(resultsOf(out.messages).filter((r) => r.content[0]?.text.startsWith('y'))).toHaveLength(
      6
    );
    expectWellFormed(out.messages);
  });

  it('stubs write and edit arguments, keeping the call id, name and path', () => {
    const big = 'q'.repeat(5_000);
    const messages: AgentMessage[] = [
      user('first'),
      assistant(
        { args: { content: big, path: 'a.ts' }, id: 'w', name: 'write' },
        {
          args: {
            edits: [
              { newText: big, oldText: big },
              { newText: 'x', oldText: 'y' },
            ],
            path: 'b.ts',
          },
          id: 'e',
          name: 'edit',
        },
        { args: { newText: big, oldText: big, path: 'c.ts' }, id: 'l', name: 'edit' },
        { args: { command: big }, id: 'b', name: 'bash' }
      ),
      result('w', 'write', 'ok'),
      result('e', 'edit', 'ok'),
      result('l', 'edit', 'ok'),
      result('b', 'bash', 'ok'),
      assistant(),
      user('second'),
    ];
    const out = compactMessages({ budgetTokens: 3_000, messages, systemPrompt: '' });
    const calls = (
      out.messages[1] as unknown as {
        content: { id: string; name: string; arguments: Record<string, unknown> }[];
      }
    ).content;
    expect(calls.map((c) => c.id)).toEqual(['w', 'e', 'l', 'b']);
    expect(calls[0]?.arguments).toEqual({ content: ARG_STUB, path: 'a.ts' });
    expect(calls[1]?.arguments).toEqual({
      edits: [
        { newText: ARG_STUB, oldText: ARG_STUB },
        { newText: 'x', oldText: 'y' },
      ],
      path: 'b.ts',
    });
    expect(calls[2]?.arguments).toEqual({
      newText: ARG_STUB,
      oldText: ARG_STUB,
      path: 'c.ts',
    });
    expect(calls[3]?.arguments).toEqual({ command: big });
    expectWellFormed(out.messages);
  });

  it('keeps one long turn of large writes within budget', () => {
    const budget = 100_000;
    const messages: AgentMessage[] = [user('long job')];
    let largest = 0;
    for (let k = 0; k < 50; k++) {
      const out = compactMessages({
        budgetTokens: budget,
        messages,
        systemPrompt: 'z'.repeat(20_000),
      });
      largest = Math.max(largest, out.afterTokens);
      messages.push(
        assistant({
          args: { content: 'w'.repeat(16_000), path: `f${k}.ts` },
          id: `w${k}`,
          name: 'write',
        }),
        result(`w${k}`, 'write', 'r'.repeat(2_000))
      );
    }
    expect(largest).toBeLessThanOrEqual(budget);
    // Without compaction the same turn is far over it.
    expect(estimateTokens('z'.repeat(20_000), messages)).toBeGreaterThan(budget);
  });
});

describe('compacting down to a target below the budget', () => {
  it('compacts on markedly fewer calls than fitting afresh each time, with a stable prefix', () => {
    const budget = 120_000;
    const sys = 'z'.repeat(20_000);
    const step = (k: number) => [
      assistant({ id: `s${k}`, name: 'bash' }),
      result(`s${k}`, 'bash', 'y'.repeat(20_000)),
    ];
    const live: AgentMessage[] = [user('go')];
    const fresh: AgentMessage[] = [user('go')];
    const compactor = createCompactor({ budgetTokens: budget, systemPrompt: sys });
    let sticky = 0;
    let stateless = 0;
    let largest = 0;
    let prefixChanges = 0;
    let previous: AgentMessage[] = [];
    for (let k = 0; k < 50; k++) {
      const out = compactor.next(live);
      sticky += out.figures ? 1 : 0;
      largest = Math.max(largest, estimateTokens(sys, out.messages));
      // Between compactions the messages already sent are sent unchanged.
      if (!out.figures && previous.length) {
        expect(out.messages.slice(0, previous.length)).toEqual(previous);
      }
      prefixChanges += out.figures ? 1 : 0;
      previous = out.messages;
      stateless +=
        compactMessages({ budgetTokens: budget, messages: fresh, systemPrompt: sys }).messages !==
        fresh
          ? 1
          : 0;
      live.push(...step(k));
      fresh.push(...step(k));
    }
    expect(largest).toBeLessThanOrEqual(budget);
    expect(sticky).toBeGreaterThan(0);
    expect(sticky).toBeLessThan(stateless / 2);
    expect(prefixChanges).toBe(sticky);
  });

  it('stops at the target share of the budget', () => {
    const messages = conversation(1, 8);
    const budget = estimateTokens('', messages) - 500;
    const out = compactMessages({ budgetTokens: budget, messages, systemPrompt: '' });
    expect(out.afterTokens).toBeLessThanOrEqual(Math.floor(budget * 0.85));
  });
});
