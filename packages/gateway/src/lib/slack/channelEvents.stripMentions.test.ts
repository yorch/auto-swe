import { describe, expect, it } from 'vitest';
import { stripMentions } from './channelEvents.js';

/** The pre-rewrite implementation, kept only as the behavioural reference. */
function legacyStripMentions(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EQUIVALENCE_CASES: string[] = [
  '',
  ' ',
  '\n\t ',
  'hello',
  '<@U1>',
  '<@U1|name>',
  '<@U1|>',
  '<@u1>',
  '<@u1|Alice Smith>',
  '<@U1|abc',
  '<@U1',
  '<@',
  '<@@',
  '<@>',
  '<@|x>',
  '<@|>',
  '<@U1|<@U2>>',
  '<@U1|<@U2>',
  '<@U1><@U2>',
  '<@U1>  <@U2|b>',
  'hello <@U1> world',
  'hi\n<@U1|x>\tthere',
  '\t\n<@U1>\n\t',
  'café <@U1> naïve',
  '<@ÜBER>',
  '<@U١>',
  '<@U1|é>',
  '<@U1|x>y>z',
  '<<@U1>>',
  '<@@U1>',
  '<@U1|a|b>',
  '<@U1 |x>',
  '<@U_1>',
  'a<@U1>b<@U2|c>d',
  '<@U1|x\n y>',
  '<@A|<@B|<@C>',
  '<@A|>>>',
  '>>><@A|',
  '<@U1>>',
  '<@U1|x>>',
  '<@1>',
  '<@ab12XY>',
  '  <@U1|x>  ',
  '<@A|x> <@B|y',
  '<@A|b c>',
  '<@A >',
  ' <@A> ',
  '<@\u{1D518}1>',
  '<@KU1>',
  '<@ſU1>',
  '<@U1|😀 emoji 😀>',
  '<@U1>😀<@U2>',
  '<@A|x<@B>y',
  '<@A><<@B>>',
];

/** Small deterministic PRNG (mulberry32) so the fuzz corpus is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_ALPHABET = ['<', '@', '|', '>', 'A', '1', ' ', 'x'];

function fuzzCorpus(count: number, seed: number): string[] {
  const random = seededRandom(seed);
  const corpus: string[] = [];
  for (let n = 0; n < count; n++) {
    const length = Math.floor(random() * 13);
    let s = '';
    for (let k = 0; k < length; k++) {
      s += FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)];
    }
    corpus.push(s);
  }
  return corpus;
}

describe('stripMentions equivalence with the legacy regex', () => {
  it.each(EQUIVALENCE_CASES.map((c) => [JSON.stringify(c), c] as const))(
    'matches the legacy regex for %s',
    (_label, input) => {
      expect(stripMentions(input)).toBe(legacyStripMentions(input));
    }
  );

  it('matches the legacy regex on 2000 seeded random short strings', () => {
    const mismatches: Array<{ input: string; legacy: string; actual: string }> = [];
    for (const input of fuzzCorpus(2000, 0x5eed)) {
      const legacy = legacyStripMentions(input);
      const actual = stripMentions(input);
      if (legacy !== actual) {
        mismatches.push({ actual, input, legacy });
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('stripMentions on hostile input', () => {
  const LONG_LATE_GT = `${'<@A|'.repeat(25000).slice(0, 99_999)}>`;
  const HOSTILE: Array<[string, string]> = [
    ["'<@A|'.repeat(25000)", '<@A|'.repeat(25000)],
    ["'<@'.repeat(50000)", '<@'.repeat(50000)],
    ["'<@A'.repeat(33000)", '<@A'.repeat(33000)],
    ["('<@A|' + 'x'.repeat(100)) repeated 1000 times", `${'<@A|'}${'x'.repeat(100)}`.repeat(1000)],
    ["'<@A|'.repeat(25000) sliced to 99_999 + '>'", LONG_LATE_GT],
  ];

  it.each(HOSTILE)('%s finishes in under 200 ms', (_label, input) => {
    const started = performance.now();
    const result = stripMentions(input);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(200);
    expect(typeof result).toBe('string');
  });

  it.each(HOSTILE.slice(0, 4))('%s with no closing > is left as ordinary text', (_label, input) => {
    expect(input).not.toContain('>');
    expect(stripMentions(input)).toBe(input);
  });

  it('collapses the late-closing token to empty output', () => {
    expect(stripMentions(LONG_LATE_GT)).toBe('');
  });
});
