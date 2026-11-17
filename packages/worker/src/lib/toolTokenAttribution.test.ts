import type { NormalizedCall } from '@auto-swe/shared/lib/transcripts/normalize';
import { describe, expect, it } from 'vitest';
import {
  attributeCallContext,
  type CacheRates,
  SpendReport,
  totalInputTokens,
} from './toolTokenAttribution.js';

const RATES: CacheRates = { read: 0.1, write: 1.25 };

function call(over: Partial<NormalizedCall> & Pick<NormalizedCall, 'messages'>): NormalizedCall {
  return {
    provider: 'anthropic',
    response: { content: [], usage: { inputTokens: 1000 } },
    ...over,
  };
}

const readThenResult: NormalizedCall['messages'] = [
  { content: [{ text: 'fix it', type: 'text' }], role: 'user' },
  {
    content: [{ id: 'a', input: { path: 'x.ts' }, name: 'readFile', type: 'tool_call' }],
    role: 'assistant',
  },
  {
    content: [{ id: 'a', output: { content: 'x'.repeat(600) }, type: 'tool_result' }],
    role: 'tool',
  },
];

describe('totalInputTokens', () => {
  it('adds cache parts for Anthropic, whose input_tokens excludes them', () => {
    expect(
      totalInputTokens(
        call({
          messages: [],
          response: { content: [], usage: { cacheRead: 700, cacheWrite: 100, inputTokens: 200 } },
        })
      )
    ).toBe(1000);
  });

  it('takes the reported total for providers whose total includes the cache', () => {
    expect(
      totalInputTokens(
        call({
          messages: [],
          provider: 'openai-chat',
          response: { content: [], usage: { cacheRead: 700, inputTokens: 1000 } },
        })
      )
    ).toBe(1000);
  });

  it('is undefined without usage', () => {
    expect(totalInputTokens(call({ messages: [], response: { content: [] } }))).toBeUndefined();
  });
});

describe('attributeCallContext', () => {
  it('splits the real input tokens across segments in proportion to their size', () => {
    const out = attributeCallContext(
      call({ messages: readThenResult, system: 's'.repeat(100) }),
      RATES
    );
    expect(out).not.toBeNull();
    const sum = [...(out?.segments.values() ?? [])].reduce((n, s) => n + s.tokens, 0);
    expect(sum).toBeCloseTo(1000, 6);
    const result = out?.segments.get('tool_result:readFile');
    const system = out?.segments.get('system');
    expect(result?.tokens ?? 0).toBeGreaterThan((system?.tokens ?? 0) * 3);
  });

  it('names a result by the tool call it answers, and an orphan result by "?"', () => {
    const out = attributeCallContext(
      call({
        messages: [
          ...readThenResult,
          { content: [{ id: 'zz', output: 'orphan', type: 'tool_result' }], role: 'tool' },
        ],
      }),
      RATES
    );
    expect(out?.segments.has('tool_result:readFile')).toBe(true);
    expect(out?.segments.has('tool_result:?')).toBe(true);
  });

  it('names a Google result by the function name when the call carries its own id', () => {
    const out = attributeCallContext(
      call({
        messages: [
          {
            content: [{ id: 'call_9', input: {}, name: 'readFile', type: 'tool_call' }],
            role: 'assistant',
          },
          { content: [{ id: 'readFile', output: 'ok', type: 'tool_result' }], role: 'tool' },
        ],
        provider: 'google',
      }),
      RATES
    );
    expect(out?.segments.has('tool_result:readFile')).toBe(true);
  });

  it('does not attribute a request that is not a real API exchange', () => {
    // A session file is one copy of the conversation beside usage summed over every call.
    for (const source of ['harness_session_file', 'harness_message'] as const) {
      expect(attributeCallContext(call({ messages: readThenResult, source }), RATES)).toBeNull();
    }
    expect(
      attributeCallContext(call({ messages: readThenResult, source: 'http_call' }), RATES)
    ).not.toBeNull();
  });

  it('counts the system prompt once when a request lists it in both places', () => {
    const system = 's'.repeat(300);
    const out = attributeCallContext(
      call({
        messages: [
          { content: [{ text: system, type: 'text' }], role: 'system' },
          { content: [{ text: 'u'.repeat(300), type: 'text' }], role: 'user' },
        ],
        provider: 'openai-chat',
        response: { content: [], usage: { inputTokens: 600 } },
        system,
      }),
      RATES
    );
    expect(out?.segments.get('system')?.tokens).toBeCloseTo(300, 6);
    expect(out?.segments.get('user')?.tokens).toBeCloseTo(300, 6);
  });

  it('weighs an image as a fixed size, not as its base64 length', () => {
    const blob = 'A'.repeat(1_400_000);
    const out = attributeCallContext(
      call({
        messages: [
          { content: [{ text: 'u'.repeat(4500), type: 'text' }], role: 'user' },
          {
            content: [
              { id: 'b', output: [{ data: blob, type: 'image' }], type: 'tool_result' },
              { reference: 'image', type: 'image' },
            ],
            role: 'tool',
          },
        ],
      }),
      RATES
    );
    // Counted by base64 length the result would hold ~99.9% of the call; as an image it is a
    // third of it, like the bare image and the same-sized user text.
    const result = out?.segments.get('tool_result:?')?.tokens ?? 0;
    expect(result).toBeGreaterThan(320);
    expect(result).toBeLessThan(345);
    expect(out?.segments.get('image')?.tokens).toBeCloseTo(332.7, 0);
    expect(out?.segments.get('user')?.tokens).toBeCloseTo(332.7, 0);
  });

  it('counts a text content block as its text, not its JSON envelope', () => {
    const wrapped = attributeCallContext(
      call({
        messages: [
          {
            content: [
              { id: 'a', output: [{ text: 'x'.repeat(500), type: 'text' }], type: 'tool_result' },
            ],
            role: 'tool',
          },
          { content: [{ text: 'u'.repeat(500), type: 'text' }], role: 'user' },
        ],
      }),
      RATES
    );
    expect(wrapped?.segments.get('tool_result:?')?.tokens).toBeCloseTo(500, 6);
  });

  it('counts tool-call arguments, so a large write is not free', () => {
    const out = attributeCallContext(
      call({
        messages: [
          {
            content: [
              {
                id: 'w',
                input: { content: 'y'.repeat(4000), path: 'a.ts' },
                name: 'writeFile',
                type: 'tool_call',
              },
            ],
            role: 'assistant',
          },
        ],
      }),
      RATES
    );
    expect(out?.segments.get('tool_call:writeFile')?.tokens).toBeCloseTo(1000, 6);
  });

  it('prices cached input as the earliest part of the prompt', () => {
    // tool schemas + system come first, so a cache read of 100 tokens lands
    // there and the later tool result is billed fresh.
    const out = attributeCallContext(
      call({
        messages: readThenResult,
        response: { content: [], usage: { cacheRead: 100, inputTokens: 600 } },
        system: 's'.repeat(200),
        tools: [{ name: 'readFile' }],
      }),
      RATES
    );
    const result = out?.segments.get('tool_result:readFile');
    expect(result?.priceEquivalent).toBeCloseTo(result?.tokens ?? -1, 6);
    const system = out?.segments.get('system');
    expect(system?.priceEquivalent).toBeLessThan(system?.tokens ?? 0);
    // price-equivalent total = fresh + read x rate
    expect(out?.priceEquivalent).toBeCloseTo(600 + 100 * 0.1, 6);
  });

  it('prices a cache write at the write rate, after the cache read', () => {
    const out = attributeCallContext(
      call({
        messages: [{ content: [{ text: 'a'.repeat(1000), type: 'text' }], role: 'user' }],
        response: { content: [], usage: { cacheRead: 250, cacheWrite: 250, inputTokens: 500 } },
      }),
      RATES
    );
    expect(out?.priceEquivalent).toBeCloseTo(500 + 250 * 0.1 + 250 * 1.25, 6);
  });

  it('clamps a cache figure larger than the prompt', () => {
    const out = attributeCallContext(
      call({
        messages: [{ content: [{ text: 'a', type: 'text' }], role: 'user' }],
        provider: 'openai-chat',
        response: { content: [], usage: { cacheRead: 5000, inputTokens: 1000 } },
      }),
      RATES
    );
    expect(out?.priceEquivalent).toBeCloseTo(1000 * 0.1, 6);
  });

  it('returns null for a zero total with cache parts on a total-inclusive provider', () => {
    expect(
      attributeCallContext(
        call({
          messages: readThenResult,
          provider: 'openai-chat',
          response: { content: [], usage: { cacheRead: 5000, inputTokens: 0 } },
        }),
        RATES
      )
    ).toBeNull();
  });

  it('returns null when it cannot measure', () => {
    expect(attributeCallContext(call({ messages: [] }), RATES)).toBeNull();
    expect(
      attributeCallContext(call({ messages: readThenResult, response: { content: [] } }), RATES)
    ).toBeNull();
  });
});

describe('SpendReport', () => {
  it('sums calls and reports each segment as a share of the total', () => {
    const report = new SpendReport();
    report.add(attributeCallContext(call({ messages: readThenResult }), RATES));
    report.add(attributeCallContext(call({ messages: readThenResult }), RATES));
    report.add(null);
    const rows = report.rows();
    expect(report.calls).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.inputTokens).toBe(2000);
    expect(rows.reduce((n, r) => n + r.tokenShare, 0)).toBeCloseTo(1, 6);
    expect(rows[0]?.key).toBe('tool_result:readFile');
  });
});
