import { describe, expect, it } from 'vitest';
import { neutralizeSlackBroadcasts } from './slackEscape.js';

/** The regex implementation this scanner replaced, kept verbatim as the behavioural reference. */
const LEGACY_BROADCAST_MENTION = /<!(?:channel|here|everyone|subteam\^[^>|\s]*)(?:\|[^>]*)?>/gi;
function legacy(text: string): string {
  return text.replace(LEGACY_BROADCAST_MENTION, (mention) =>
    mention.replace('<', '&lt;').replace(/>$/, '&gt;')
  );
}

const PATTERN = /<!(?:channel|here|everyone|subteam\^[^>|\s]*)(?:\|[^>]*)?>/i;
const matches = (s: string) => PATTERN.test(s);
const RAW_OPENER = /<!(?:channel|here|everyone|subteam\^)/i;

/**
 * Differential check. The regex version consumed a whole token, so an opener nested in another
 * opener's label survived (`<!here|<!here|x>>` -> `<!here|x&gt;>`). The scanner resolves every
 * opener on its own and is deliberately stricter there. So the two must agree exactly wherever the
 * legacy output left no raw broadcast opener at all (a bare pattern-miss is not enough: `<!channel|<!here>>` leaves `<!here&gt;>`); where it did, only the new output is held to the fixed point.
 */
function expectAgreement(input: string): void {
  const next = neutralizeSlackBroadcasts(input);
  const old = legacy(input);
  if (!RAW_OPENER.test(old)) {
    expect(next, JSON.stringify(input)).toBe(old);
  }
  expect(matches(next), JSON.stringify(input)).toBe(false);
  expect(neutralizeSlackBroadcasts(next), JSON.stringify(input)).toBe(next);
}

const TABLE: string[] = [
  '',
  'plain text',
  '<!channel>',
  '<!here>',
  '<!everyone>',
  '<!CHANNEL>',
  '<!Here>',
  '<!EvErYoNe>',
  '<!channel|label>',
  '<!here|>',
  '<!everyone|a b c>',
  '<!subteam^S123>',
  '<!subteam^S123|@team>',
  '<!SUBTEAM^S123|@team>',
  '<!subteam^>',
  '<!subteam^ S1>',
  '<!subteam^S1 >',
  '<!subteam^S1\n>',
  '<!subteam^S1|>',
  '<!subteam^S1<!here>',
  '<!channel',
  '<!channel|',
  '<!channel|label',
  '<!subteam^S123',
  '<!subteam^S123|label',
  '<!channel<!here>>',
  '<!channel<!here>',
  '<!here><!channel><!everyone>',
  '<!here> <!here>',
  'hello <!channel> world <!here|x> bye',
  '<!channels>',
  '<! channel>',
  '<!chan>',
  '<!channel >',
  '<!channel|a>b>',
  '<!channel|a\nb>',
  '<!channel|<!here>>',
  '<@U123> <https://x.example|l> <!date^1|x>',
  'ünïcode <!channel> ünï',
  '日本語 <!here|日本語> 日本語',
  '<!ſubteam^S1>',
  '<!ｃhannel>',
  '<!subteam^S1 >',
  '<!subteam^S1 |x>',
  '<!channel​>',
  '<​!channel>',
  '<!',
  '<',
  '<!<!<!channel>',
  '\n<!channel>\n',
  '<!subteam^a<!subteam^b>',
  '<!subteam^a|b|c>',
  '&lt;!channel&gt; <!here>',
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WIDE_ALPHABET = [
  '<',
  '!',
  '>',
  '|',
  '^',
  'c',
  'h',
  'a',
  'n',
  'e',
  'l',
  'S',
  '1',
  ' ',
  '@',
  'C',
  'H',
  'E',
  'N',
  'L',
  'T',
  'U',
  'B',
  'M',
  'V',
  'R',
  'Y',
  'O',
  '\n',
  '\t',
  '&',
  ' ',
  ' ',
  '\u0000',
];
const WIDE_FRAGMENTS = [
  '<!',
  '<!',
  'channel',
  'here',
  'everyone',
  'subteam^',
  'CHANNEL',
  'Here',
  'EVERYONE',
  'SubTeam^',
  'S1',
  '|',
  '>',
  '>',
  ' ',
  'x',
  '<',
  '\n',
  '\t',
  '&',
  ' ',
  ' ',
  '\u0000',
];

function randomString(rand: () => number, pool: string[], maxLen: number): string {
  const len = Math.floor(rand() * (maxLen + 1));
  let s = '';
  for (let k = 0; k < len; k++) {
    s += pool[Math.floor(rand() * pool.length)];
  }
  return s;
}

/**
 * Independent reference: the old regex, sticky and case-insensitive, tried at EVERY `<!` position
 * (not skipping over a match), escaping that opener's `<` and the `>` where its match ended.
 */
function reference(text: string): string {
  const re = /<!(?:channel|here|everyone|subteam\^[^>|\s]*)(?:\|[^>]*)?>/iy;
  const lt = new Set<number>();
  const gt = new Set<number>();
  for (let pos = text.indexOf('<!'); pos !== -1; pos = text.indexOf('<!', pos + 1)) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (m) {
      lt.add(pos);
      gt.add(pos + m[0].length - 1);
    }
  }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += lt.has(i) ? '&lt;' : gt.has(i) ? '&gt;' : text[i];
  }
  return out;
}

describe('neutralizeSlackBroadcasts equivalence with the regex version', () => {
  it.each(TABLE.map((t) => [JSON.stringify(t), t]))('matches legacy on %s', (_n, input) => {
    expectAgreement(input as string);
  });

  it('holds over 3000 seeded random strings', () => {
    const alphabet = ['<', '!', '>', '|', '^', 'c', 'h', 'a', 'n', 'e', 'l', 'S', '1', ' ', '@'];
    const rand = mulberry32(0xc0ffee);
    for (let i = 0; i < 3000; i++) {
      expectAgreement(randomString(rand, alphabet, 40));
    }
  });

  it('holds over 3000 seeded strings built from broadcast fragments', () => {
    const frags = ['<!', 'channel', 'here', 'everyone', 'subteam^', 'S1', '|', '>', ' ', 'x', '<'];
    const rand = mulberry32(42);
    for (let i = 0; i < 3000; i++) {
      expectAgreement(randomString(rand, frags, 11));
    }
  });

  it('holds over 20000 strings from a wide alphabet (mixed case, whitespace, NUL), up to 120 long', () => {
    const rand = mulberry32(2024);
    for (let i = 0; i < 20000; i++) {
      expectAgreement(randomString(rand, WIDE_ALPHABET, 120));
    }
  });

  it('holds over 20000 strings of mixed-case broadcast fragments, up to 120 long', () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 20000; i++) {
      expectAgreement(randomString(rand, WIDE_FRAGMENTS, 120));
    }
  });
});

describe('neutralizeSlackBroadcasts nesting and idempotence', () => {
  it.each([
    ['<!here|<!here|x>>', '&lt;!here|&lt;!here|x&gt;>'],
    ['<!channel|<!here>|y>', '&lt;!channel|&lt;!here&gt;|y>'],
    ['<!here|<!channel|<!everyone|x>>>', '&lt;!here|&lt;!channel|&lt;!everyone|x&gt;>>'],
    ['<!subteam^A|<!subteam^B|x>>', '&lt;!subteam^A|&lt;!subteam^B|x&gt;>'],
    ['<!here|<!channel>', '&lt;!here|&lt;!channel&gt;'],
    ['<!here|<!here|x', '<!here|<!here|x'],
    ['<!here|<!here>', '&lt;!here|&lt;!here&gt;'],
    ['<!here><!channel>', '&lt;!here&gt;&lt;!channel&gt;'],
  ])('%s', (input, expected) => {
    expect(neutralizeSlackBroadcasts(input)).toBe(expected);
    expect(matches(neutralizeSlackBroadcasts(input))).toBe(false);
  });

  it('is a fixed point with no residual token over 20000 heavily nested strings', () => {
    const frags = [
      '<!',
      'channel',
      'here',
      'everyone',
      'subteam^',
      'S1',
      '|',
      '>',
      '>',
      ' ',
      'x',
      '<',
    ];
    const rand = mulberry32(7);
    for (let i = 0; i < 20000; i++) {
      expectAgreement(randomString(rand, frags, 23));
    }
  });
});

describe('neutralizeSlackBroadcasts against an independent reference', () => {
  it('equals the sticky-regex reference on 20000 nesting-heavy strings', () => {
    const rand = mulberry32(31337);
    for (let i = 0; i < 20000; i++) {
      const pool = i % 2 === 0 ? WIDE_FRAGMENTS : WIDE_ALPHABET;
      const s = randomString(rand, pool, 60);
      expect(neutralizeSlackBroadcasts(s), JSON.stringify(s)).toBe(reference(s));
    }
  });

  it('the reference itself reproduces the nested case', () => {
    expect(reference('<!here|<!here|x>>')).toBe('&lt;!here|&lt;!here|x&gt;>');
  });
});

describe('neutralizeSlackBroadcasts security', () => {
  const RAW = /<!(?:channel|here|everyone|subteam\^)/i;

  /** Inputs whose every broadcast opener closes: the output must hold no raw opener at all. */
  const DEFUSED: [string, string][] = [
    ['<!channel>', '&lt;!channel&gt;'],
    ['<!here>', '&lt;!here&gt;'],
    ['<!everyone>', '&lt;!everyone&gt;'],
    ['<!subteam^S1>', '&lt;!subteam^S1&gt;'],
    ['<!channel|x>', '&lt;!channel|x&gt;'],
    ['<!CHANNEL|x>', '&lt;!CHANNEL|x&gt;'],
    ['<!Here|\n>', '&lt;!Here|\n&gt;'],
    ['<!subteam^S1|@a>', '&lt;!subteam^S1|@a&gt;'],
    ['a<!channel>b<!here>c', 'a&lt;!channel&gt;b&lt;!here&gt;c'],
    ['<!channel><!channel>', '&lt;!channel&gt;&lt;!channel&gt;'],
    ['<!channel|<!here>>', '&lt;!channel|&lt;!here&gt;>'],
    ['<!subteam^a<!subteam^b>', '&lt;!subteam^a&lt;!subteam^b&gt;'],
    ['<!here|<!everyone|<!channel>>>', '&lt;!here|&lt;!everyone|&lt;!channel&gt;>>'],
    ['<!subteam^>', '&lt;!subteam^&gt;'],
    ['&lt;!channel&gt;<!here>', '&lt;!channel&gt;&lt;!here&gt;'],
    ['<<!channel>>', '<&lt;!channel&gt;>'],
    ['<!<!channel>', '<!&lt;!channel&gt;'],
    ['*<!channel>* `<!here>`', '*&lt;!channel&gt;* `&lt;!here&gt;`'],
    // Not openers at all (a zero-width character or a second `!` breaks `<!word`): untouched.
    ['<!ch​annel>', '<!ch​annel>'],
    ['<​!channel>', '<​!channel>'],
    ['<!!channel>', '<!!channel>'],
  ];

  /**
   * Inputs where a raw opener is deliberately left as written, each for a stated reason. In every
   * case the opener is not a mention Slack would resolve: nothing closes it, or it is not followed
   * directly by `>` or `|` (or, for subteam, its id is cut off by whitespace). The old regex left
   * the same text untouched.
   */
  const LEFT_AS_WRITTEN: [string, string, string][] = [
    ['<!channel|', '<!channel|', 'no closing > anywhere'],
    ['<!channel', '<!channel', 'no closing > anywhere'],
    ['<!subteam^S1', '<!subteam^S1', 'no closing > anywhere'],
    ['<!subteam^S1|label', '<!subteam^S1|label', 'no closing > anywhere'],
    ['<!channel<!here>>', '<!channel&lt;!here&gt;>', 'channel is followed by <, not > or |'],
    ['<!channel​>', '<!channel​>', 'channel is followed by a zero-width space'],
    ['<!channel >', '<!channel >', 'channel is followed by whitespace'],
    ['<!subteam^S1 >', '<!subteam^S1 >', 'subteam id is cut off by whitespace'],
    ['<!subteam^ >', '<!subteam^ >', 'subteam id is cut off by whitespace'],
  ];

  it.each(DEFUSED.map((c) => [JSON.stringify(c[0]), c[0], c[1]]))(
    'defuses %s',
    (_n, input, expected) => {
      const out = neutralizeSlackBroadcasts(input as string);
      expect(out).toBe(expected);
      expect(RAW.test(out)).toBe(false);
    }
  );

  it.each(LEFT_AS_WRITTEN.map((c) => [`${JSON.stringify(c[0])} (${c[2]})`, c[0], c[1]]))(
    'leaves %s as written',
    (_n, input, expected) => {
      const out = neutralizeSlackBroadcasts(input as string);
      expect(out).toBe(expected);
      expect(matches(out)).toBe(false);
    }
  );
});

describe('neutralizeSlackBroadcasts runs in linear time on hostile input', () => {
  const cases: [string, string][] = [
    ['unterminated <!channel|', '<!channel|'.repeat(20000)],
    ['unterminated <!subteam^A', '<!subteam^A'.repeat(20000)],
    ['bare <!', '<!'.repeat(50000)],
    ['<!here| then long tails', `<!here|${'x'.repeat(100)}`.repeat(1000)],
    ['deeply nested', `${'<!here|'.repeat(50000)}x${'>'.repeat(50000)}`],
    ['nested subteam', `${'<!subteam^A|'.repeat(20000)}x${'>'.repeat(20000)}`],
  ];
  it.each(cases)('%s finishes under 200 ms', (_n, input) => {
    const start = performance.now();
    neutralizeSlackBroadcasts(input);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
