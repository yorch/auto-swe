import { describe, expect, it } from 'vitest';
import { BUILTIN_SCANNER_PATTERNS } from '../scannerPatterns/index.js';
import {
  capScanText,
  checkRegexSafety,
  isRegexSafe,
  MAX_PATTERN_SOURCE_LENGTH,
  MAX_SCAN_TEXT_LENGTH,
} from './regexSafety.js';

describe('checkRegexSafety — catastrophic backtracking', () => {
  it.each([
    ['(a+)+$', 'classic nested quantifier'],
    ['^(a+)+$', 'anchored nested quantifier'],
    ['([a-zA-Z]+)*$', 'nested quantifier over a class'],
    ['(\\s*\\w+)*!', 'nullable prefix widens the first set'],
    ['(a|aa)+$', 'overlapping alternation branches'],
    ['(a|ab)+$', 'prefix-overlapping alternation branches'],
    ['(x)(y(\\d+)+z)*', 'risk nested inside another group'],
    ['(.*)*x', 'wildcard nested repetition'],
    ['(a+){2,}', 'unbounded {n,} counts as repetition'],
    ['(x+)+y', 'literals outside the base sampling alphabet still overlap'],
  ])('rejects %j (%s)', (pattern) => {
    const issue = checkRegexSafety(pattern, 'i');
    expect(issue?.code).toBe('REDOS_RISK');
    expect(issue?.message).toMatch(/catastrophic backtracking/);
  });
});

describe('checkRegexSafety — accepts ordinary patterns', () => {
  it.each([
    'ignore\\s+(all\\s+)?previous\\s+instructions',
    '\\b(?:nc|netcat|ncat)\\b\\s+(?:-[a-z]+\\s+)*[\\w.-]+\\s+\\d{1,5}\\b',
    '(foo|bar)+',
    'https?:\\/\\/[^\\s]+',
    '(?:^|[\\s"`\'])[A-Za-z0-9+/]{60,}={0,2}(?:$|[\\s"`\'])',
    '^\\.env(rc)?(\\.(?!example$|sample$|template$).+)?$',
    '(?<name>[a-z]+)-\\d+',
  ])('accepts %j', (pattern) => {
    expect(checkRegexSafety(pattern, 'i')).toBeNull();
  });

  it('accepts every shipped built-in pattern', () => {
    const rejected = BUILTIN_SCANNER_PATTERNS.filter((p) => !isRegexSafe(p.pattern, p.flags)).map(
      (p) => `${p.label}: ${checkRegexSafety(p.pattern, p.flags)?.message}`
    );
    expect(rejected).toEqual([]);
  });
});

describe('checkRegexSafety — other rejections', () => {
  it('rejects an uncompilable pattern', () => {
    expect(checkRegexSafety('(', '')?.code).toBe('INVALID_REGEX');
  });

  it('rejects stateful flags', () => {
    expect(checkRegexSafety('abc', 'gi')?.code).toBe('UNSAFE_FLAGS');
  });

  it('rejects an over-long pattern body', () => {
    const issue = checkRegexSafety('a'.repeat(MAX_PATTERN_SOURCE_LENGTH + 1), '');
    expect(issue?.code).toBe('PATTERN_TOO_LONG');
  });

  it('rejects a pattern nested past the analysis depth limit', () => {
    const deep = `${'('.repeat(40)}a${')'.repeat(40)}`;
    expect(checkRegexSafety(deep, '')?.code).toBe('REDOS_RISK');
  });
});

describe('checkRegexSafety — the rejected patterns really are slow', () => {
  it('a rejected pattern blows up on modest input while the accepted rewrite does not', () => {
    const evil = /^(a+)+$/;
    const safe = /^a+$/;
    const input = `${'a'.repeat(26)}!`;

    const t0 = Date.now();
    safe.test(input);
    const safeMs = Date.now() - t0;

    const t1 = Date.now();
    evil.test(input);
    const evilMs = Date.now() - t1;

    expect(safeMs).toBeLessThan(50);
    expect(evilMs).toBeGreaterThan(safeMs);
    // The gate that matters: the pattern above never reaches the DB.
    expect(checkRegexSafety('^(a+)+$', '')?.code).toBe('REDOS_RISK');
  });
});

describe('capScanText', () => {
  it('passes short text through unchanged', () => {
    expect(capScanText('hello')).toBe('hello');
  });

  it('truncates at the cap', () => {
    expect(capScanText('x'.repeat(MAX_SCAN_TEXT_LENGTH + 500))).toHaveLength(MAX_SCAN_TEXT_LENGTH);
  });
});
