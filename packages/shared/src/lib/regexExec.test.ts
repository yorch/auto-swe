import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn(async (_args?: unknown) => [] as unknown[]);
vi.mock('../db.js', () => ({ prisma: { configSetting: { findMany } } }));

import { invalidateSettingsCache } from '../config/resolveSetting.js';
import { BUILTIN_SCANNER_PATTERNS } from '../scannerPatterns/index.js';
import {
  DEFAULT_REGEX_BUDGET_MS,
  isRegexQuarantined,
  probeRegexBacktracking,
  resetRegexExecutor,
  resolveRegexBudgetMs,
  runRegexBatch,
} from './regexExec.js';

/** The catastrophic pattern every reviewer reaches for, plus its input. */
const EVIL = { flags: '', key: 'evil', source: '(a+)+$' };
const EVIL_INPUT = `${'a'.repeat(40)}!`;

afterEach(() => {
  resetRegexExecutor();
});

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  invalidateSettingsCache();
  delete process.env.SCANNER_REGEX_BUDGET_MS;
});

describe('runRegexBatch — ordinary matching', () => {
  it('returns a hit per matching pattern/target pair', async () => {
    const result = await runRegexBatch(
      [
        { flags: '', key: 'p1', source: '\\bfoo\\b' },
        { flags: 'i', key: 'p2', source: 'BAR' },
      ],
      [
        { key: 't1', text: 'hello foo' },
        { key: 't2', text: 'a bar here' },
      ]
    );
    expect(result.incomplete).toBe(false);
    expect(result.hits).toEqual([
      { match: 'foo', patternKey: 'p1', targetKey: 't1' },
      { match: 'bar', patternKey: 'p2', targetKey: 't2' },
    ]);
  });

  it('is a no-op with no patterns or no targets', async () => {
    await expect(runRegexBatch([], [{ key: 't', text: 'x' }])).resolves.toMatchObject({
      hits: [],
      incomplete: false,
    });
    await expect(runRegexBatch([{ flags: '', key: 'p', source: 'x' }], [])).resolves.toMatchObject({
      hits: [],
      incomplete: false,
    });
  });

  it('skips a pattern that does not compile instead of failing the batch', async () => {
    const result = await runRegexBatch(
      [
        { flags: '', key: 'broken', source: '(' },
        { flags: '', key: 'ok', source: 'x' },
      ],
      [{ key: 't', text: 'x' }]
    );
    expect(result.incomplete).toBe(false);
    expect(result.hits.map((h) => h.patternKey)).toEqual(['ok']);
  });
});

describe('runRegexBatch — the worker caches compiled patterns by source+flags identity', () => {
  it('returns identical results across repeated batches of the same pattern (the cache does not change matches)', async () => {
    const patterns = [
      { flags: 'i', key: 'p1', source: '\\bfoo\\b' },
      { flags: '', key: 'p2', source: 'bar' },
    ];
    const targets = [{ key: 't', text: 'FOO and bar' }];

    const first = await runRegexBatch(patterns, targets);
    const second = await runRegexBatch(patterns, targets);
    const third = await runRegexBatch(patterns, targets);

    const expected = {
      hits: [
        { match: 'FOO', patternKey: 'p1', targetKey: 't' },
        { match: 'bar', patternKey: 'p2', targetKey: 't' },
      ],
      incomplete: false,
      quarantinedPatternKeys: [],
      timedOutPatternKeys: [],
    };
    expect(first).toEqual(expected);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('attributes hits to the right key when two distinct patterns share one source+flags identity (one compiled RegExp, two callers)', async () => {
    // Mirrors what toRegexSpecs' keyPrefix produces: the same admin pattern
    // reused under two different category keys.
    const result = await runRegexBatch(
      [
        { flags: '', key: 'injection:jailbreak', source: 'jailbreak' },
        { flags: '', key: 'exfiltration:jailbreak', source: 'jailbreak' },
      ],
      [{ key: 't', text: 'a jailbreak attempt' }]
    );
    expect(result.hits.map((h) => h.patternKey).sort()).toEqual([
      'exfiltration:jailbreak',
      'injection:jailbreak',
    ]);
  });

  it('keeps matching correctly on a g-flag pattern across repeated batches (lastIndex reset survives caching)', async () => {
    const pattern = { flags: 'g', key: 'g-rule', source: 'foo' };
    const first = await runRegexBatch([pattern], [{ key: 't', text: 'foo' }]);
    const second = await runRegexBatch([pattern], [{ key: 't', text: 'foo' }]);
    expect(first.hits).toHaveLength(1);
    expect(second.hits).toHaveLength(1);
  });
});

describe('runRegexBatch — the execution budget is the actual containment', () => {
  it('terminates a catastrophic pattern instead of wedging the process', async () => {
    const started = Date.now();
    const result = await runRegexBatch([EVIL], [{ key: 't', text: EVIL_INPUT }], {
      budgetMs: 150,
    });
    // Unbounded, `(a+)+$` on this input runs for minutes.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.incomplete).toBe(true);
    expect(result.timedOutPatternKeys).toEqual(['evil']);
  });

  // Every one of these was ACCEPTED by the deleted structural gate.
  it.each([
    [
      '(a+){1,50}$',
      '',
      `${'a'.repeat(40)}!`,
      'bounded outer quantifier — the old rules needed max === Infinity',
    ],
    ['(a{1,2})+$', '', `${'a'.repeat(40)}!`, 'bounded inner quantifier'],
    ['(a+){10}$', '', `${'a'.repeat(40)}!`, 'exact outer repetition count'],
    ['(w+)+$', '', `${'w'.repeat(40)}!`, 'literal w — the old alphabet only sampled literals'],
    ['(\\w+)+$', '', `${'a'.repeat(40)}!`, 'the escape form the old gate DID catch, for contrast'],
    ['([Ѐ-ӿ]+)+$', '', `${'Ѐ'.repeat(40)}!`, 'non-ASCII class outside any sampling alphabet'],
    [
      '([[a-z]--[q]]+)+$',
      'v',
      `${'a'.repeat(40)}!`,
      'v-mode class difference the old parser mis-parsed',
    ],
    // Polynomial rather than exponential: harmless at 40 characters, minutes at
    // 20k. Nothing structural and nothing at write time sees these — only the
    // wall-clock budget does.
    ['(a+a+)$', '', `${'a'.repeat(20_000)}!`, 'sibling quantifiers, no nesting at all'],
    ['a+a+$', '', `${'a'.repeat(20_000)}!`, 'quadratic, no group at all'],
    ['.*.*.*x', '', 'a'.repeat(20_000), 'cubic wildcard chain at exactly the old scan cap'],
  ])('bounds %s (%s)', async (source, flags, input) => {
    const result = await runRegexBatch([{ flags, key: 'p', source }], [{ key: 't', text: input }], {
      budgetMs: 150,
    });
    expect(result.incomplete).toBe(true);
    expect(result.timedOutPatternKeys).toEqual(['p']);
  });

  it('blames only the pattern that hung and keeps the other results', async () => {
    const result = await runRegexBatch(
      [
        { flags: '', key: 'before', source: 'hello' },
        EVIL,
        { flags: '', key: 'after', source: 'a!$' },
      ],
      [{ key: 't', text: `hello ${EVIL_INPUT}` }],
      { budgetMs: 150 }
    );
    expect(result.timedOutPatternKeys).toEqual(['evil']);
    expect(result.hits.map((h) => h.patternKey).sort()).toEqual(['after', 'before']);
    expect(result.incomplete).toBe(true);
  });

  it('quarantines the offender so it cannot deny every later scan', async () => {
    await runRegexBatch([EVIL], [{ key: 't', text: EVIL_INPUT }], { budgetMs: 150 });
    expect(isRegexQuarantined(EVIL.source, EVIL.flags)).toBe(true);

    const started = Date.now();
    const second = await runRegexBatch(
      [EVIL, { flags: '', key: 'ok', source: 'hello' }],
      [{ key: 't', text: `hello ${EVIL_INPUT}` }],
      { budgetMs: 150 }
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    // KNOWN LIMITATION, pinned deliberately: a quarantined rule is NOT enforced
    // on later scans, and those scans report themselves complete. The
    // alternative — refusing every scan forever — turns one bad admin pattern
    // into a total outage. Changing this is a visible test change.
    expect(second.quarantinedPatternKeys).toEqual(['evil']);
    expect(second.incomplete).toBe(false);
    expect(second.hits.map((h) => h.patternKey)).toEqual(['ok']);
  });

  it('recovers a working executor after a termination', async () => {
    await runRegexBatch([EVIL], [{ key: 't', text: EVIL_INPUT }], { budgetMs: 150 });
    const after = await runRegexBatch(
      [{ flags: '', key: 'ok', source: '\\bfoo\\b' }],
      [{ key: 't', text: 'foo' }]
    );
    expect(after.incomplete).toBe(false);
    expect(after.hits).toHaveLength(1);
  });

  it('serialises concurrent batches so one hang cannot corrupt another', async () => {
    const [bad, good] = await Promise.all([
      runRegexBatch([EVIL], [{ key: 't', text: EVIL_INPUT }], { budgetMs: 150 }),
      runRegexBatch([{ flags: '', key: 'ok', source: 'foo' }], [{ key: 't', text: 'foo' }], {
        budgetMs: 150,
      }),
    ]);
    expect(bad.timedOutPatternKeys).toEqual(['evil']);
    expect(good.incomplete).toBe(false);
    expect(good.hits.map((h) => h.patternKey)).toEqual(['ok']);
  });
});

describe('resolveRegexBudgetMs — operator-tunable via the setting registry', () => {
  it('falls back to the default when nothing overrides it', async () => {
    await expect(resolveRegexBudgetMs()).resolves.toBe(DEFAULT_REGEX_BUDGET_MS);
  });

  it('reflects a GLOBAL override, proving the effective budget comes from the setting', async () => {
    findMany.mockResolvedValue([
      { key: 'workspace.regexScanBudgetMs', scope: 'GLOBAL', value: 5_000 },
    ]);
    await expect(resolveRegexBudgetMs()).resolves.toBe(5_000);
  });

  it('honours the env var fallback between the cascade and the default', async () => {
    process.env.SCANNER_REGEX_BUDGET_MS = '9000';
    await expect(resolveRegexBudgetMs()).resolves.toBe(9_000);
  });

  it('falls back to the default, and never throws, when resolution fails', async () => {
    findMany.mockRejectedValue(new Error('database is unreachable'));
    await expect(resolveRegexBudgetMs()).resolves.toBe(DEFAULT_REGEX_BUDGET_MS);
  });

  it('an overridden budget actually changes what runRegexBatch enforces', async () => {
    findMany.mockResolvedValue([
      { key: 'workspace.regexScanBudgetMs', scope: 'GLOBAL', value: 150 },
    ]);
    const budgetMs = await resolveRegexBudgetMs();
    const started = Date.now();
    const result = await runRegexBatch([EVIL], [{ key: 't', text: EVIL_INPUT }], { budgetMs });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.incomplete).toBe(true);
    expect(result.timedOutPatternKeys).toEqual(['evil']);
  });
});

describe('probeRegexBacktracking — empirical write-time check', () => {
  it.each([
    '(a+)+$',
    '^(a+)+$',
    '(a+){1,50}$',
    '(a{1,2})+$',
    '(a+){10}$',
    '(a|aa)+$',
    '([a-zA-Z]+)*$',
    '(\\s*\\w+)*!',
    '(.*)*x',
    '(w+)+$',
    '(\\w+)+$',
    '\\d+\\d+\\d+\\d+$',
    '([Ѐ-ӿ]+)+$',
  ])('rejects %j', async (pattern) => {
    await expect(probeRegexBacktracking(pattern, 'i')).resolves.toMatch(/execution budget/);
  });

  it('rejects a v-mode class-difference pattern', async () => {
    await expect(probeRegexBacktracking('([[a-z]--[q]]+)+$', 'v')).resolves.toMatch(
      /execution budget/
    );
  });

  it.each([
    // Every one of these was REJECTED by the deleted structural analyser.
    '(?:\\w+\\.)+\\w+',
    '(?:\\d+\\.)+\\d+',
    '(?:[^,]+,)+[^,]+',
    '(foo|bar|baz)+',
    '(a|ab)+$',
    'ignore\\s+(all\\s+)?previous\\s+instructions',
    '\\b(?:nc|netcat|ncat)\\b\\s+(?:-[a-z]+\\s+)*[\\w.-]+\\s+\\d{1,5}\\b',
    'https?:\\/\\/[^\\s]+',
    '^\\.env(rc)?(\\.(?!example$|sample$|template$).+)?$',
    '(?<name>[a-z]+)-\\d+',
    '(?:[0-9]{1,3}\\.){3}[0-9]{1,3}',
  ])('accepts the ordinary pattern %j', async (pattern) => {
    await expect(probeRegexBacktracking(pattern, 'i')).resolves.toBeNull();
  });

  it('accepts every shipped built-in scanner pattern', async () => {
    const rejected: string[] = [];
    for (const p of BUILTIN_SCANNER_PATTERNS) {
      const message = await probeRegexBacktracking(p.pattern, p.flags ?? '');
      if (message) {
        rejected.push(p.label);
      }
    }
    expect(rejected).toEqual([]);
  });

  it("accepts this repo's own hardcoded shell-scanner regexes", async () => {
    // These are the two the deleted analyser rejected — an admin could not have
    // added a rule the codebase itself ships. Kept literal here so the worker
    // package's constants stay unexported and this assertion still guards them.
    const repoRegexes: Array<[string, string]> = [
      [
        '(?:^|[\\s;&|(])(?:\\d+|&)?>{1,2}\\s*(?!&)(?:\'([^\']+)\'|"([^"]+)"|([^\\s;&|)<>\'"]+))',
        'g',
      ],
      [
        '\\btee\\b(?:\\s+(?:-a|--append|-i|--ignore-interrupts))*\\s+(?:\'([^\']+)\'|"([^"]+)"|([^\\s;&|)<>\'"-][^\\s;&|)<>\'"]*))',
        'g',
      ],
      ['\\bdd\\b[^;&|]*?\\bof=(?:\'([^\']+)\'|"([^"]+)"|([^\\s;&|)<>\'"]+))', 'g'],
      [
        '\\b(?:cp|mv|install)\\b((?:\\s+(?:-[^\\s;&|]+|\'[^\']+\'|"[^"]+"|[^\\s;&|)<>\'"]+))+)',
        'g',
      ],
      [
        '\\b(?:echo|printf)\\b\\s+(?:-[a-zA-Z]+\\s+)*(?:\'([^\']*)\'|"([^"]*)"|([^\\s;&|<>]+))[^;&|<>]*?>{1,2}\\s*(?:\'([^\']+)\'|"([^"]+)"|([^\\s;&|)<>\'"]+))',
        'g',
      ],
      [
        '<<-?\\s*(?:\'([A-Za-z_][\\w]*)\'|"([A-Za-z_][\\w]*)"|([A-Za-z_][\\w]*))([\\s\\S]*?)^\\3?\\2?\\1?$',
        'gm',
      ],
    ];
    const rejected: string[] = [];
    for (const [source, flags] of repoRegexes) {
      if (await probeRegexBacktracking(source, flags)) {
        rejected.push(source);
      }
    }
    expect(rejected).toEqual([]);
  });

  it('KNOWN LIMITATION: misses a polynomial pattern (only the runtime budget catches it)', async () => {
    // `a+a+$` is quadratic — harmless at probe-corpus lengths, minutes at 20k.
    // Pinned so that improving the probe is a visible test change rather than a
    // silent one.
    await expect(probeRegexBacktracking('a+a+$', '')).resolves.toBeNull();
  });

  it('KNOWN LIMITATION: misses a blow-up whose alphabet it cannot synthesise', async () => {
    // `\p{Script=Greek}` names no Greek character in its source, so no corpus
    // string exercises it. The runtime budget still contains it.
    await expect(probeRegexBacktracking('(\\p{Script=Greek}+)+$', 'u')).resolves.toBeNull();
  });
});
