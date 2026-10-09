import { describe, expect, it } from 'vitest';
import {
  CI_TRIAGE_DEFAULTS,
  CI_TRIAGE_INPUT_SCHEMA,
  CiTriagePayloadSchema,
  GlobListSchema,
  globMatch,
  matchesPatterns,
} from './ciTrigger.js';
import { inputSchemaProblems } from './inputSchema.js';

describe('globMatch', () => {
  it('matches literally outside the wildcards', () => {
    expect(globMatch('main', 'main')).toBe(true);
    expect(globMatch('main', 'mainline')).toBe(false);
    expect(globMatch('release/1.4', 'release/1x4')).toBe(false);
  });

  it('keeps * within one path segment and lets ** cross them', () => {
    expect(globMatch('release/*', 'release/1.4')).toBe(true);
    expect(globMatch('release/*', 'release/1.4/hotfix')).toBe(false);
    expect(globMatch('release/**', 'release/1.4/hotfix')).toBe(true);
    expect(globMatch('.github/workflows/*.yml', '.github/workflows/ci.yml')).toBe(true);
  });

  it('treats regex metacharacters as literals', () => {
    expect(globMatch('a+b', 'a+b')).toBe(true);
    expect(globMatch('a+b', 'aab')).toBe(false);
    expect(globMatch('(x)', '(x)')).toBe(true);
  });

  it('refuses an empty or oversized pattern', () => {
    expect(globMatch('', '')).toBe(false);
    expect(globMatch('a'.repeat(201), 'a'.repeat(201))).toBe(false);
  });
});

describe('matchesPatterns', () => {
  it('selects nothing from an empty list', () => {
    expect(matchesPatterns([], 'main')).toBe(false);
  });

  it('lets a later exclusion override an earlier match', () => {
    const patterns = ['release/*', '!release/legacy'];
    expect(matchesPatterns(patterns, 'release/1.4')).toBe(true);
    expect(matchesPatterns(patterns, 'release/legacy')).toBe(false);
    expect(matchesPatterns(patterns, 'main')).toBe(false);
  });

  it('cannot select with exclusions alone', () => {
    expect(matchesPatterns(['!main'], 'feature/x')).toBe(false);
  });
});

describe('GlobListSchema', () => {
  it('requires at least one positive pattern', () => {
    expect(GlobListSchema.safeParse([]).success).toBe(false);
    expect(GlobListSchema.safeParse(['!main']).success).toBe(false);
    expect(GlobListSchema.safeParse(['main', '!x']).success).toBe(true);
  });
});

describe('CiTriagePayloadSchema', () => {
  const valid = {
    baseBranch: 'release/1.4',
    connectionId: '11111111-1111-4111-8111-111111111111',
    githubRunId: '12345678901',
    mode: 'fix',
    runAttempt: 1,
  };

  it('accepts a run reference', () => {
    expect(CiTriagePayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses a URL or anything else in place of a run id', () => {
    for (const githubRunId of ['https://api.github.com/x', '0', '-1', '1e9', '99999999999999999']) {
      expect(CiTriagePayloadSchema.safeParse({ ...valid, githubRunId }).success).toBe(false);
    }
  });

  it('refuses a malformed base branch', () => {
    expect(CiTriagePayloadSchema.safeParse({ ...valid, baseBranch: 'a..b' }).success).toBe(false);
  });
});

describe('CiTriagePayloadSchema defaults', () => {
  it('fills every option with the one shared default', () => {
    const parsed = CiTriagePayloadSchema.parse({
      baseBranch: 'main',
      connectionId: '11111111-1111-4111-8111-111111111111',
      githubRunId: '1',
      runAttempt: 1,
    });
    expect(parsed).toMatchObject(CI_TRIAGE_DEFAULTS);
  });

  it('declares a sound input schema', () => {
    expect(inputSchemaProblems(CI_TRIAGE_INPUT_SCHEMA)).toEqual([]);
  });

  it('declares the same defaults on the input schema the form is rendered from', () => {
    for (const [key, value] of Object.entries(CI_TRIAGE_DEFAULTS)) {
      expect(CI_TRIAGE_INPUT_SCHEMA.properties[key]?.default).toEqual(value);
    }
  });

  it.each([
    ['an empty category list', { fixCategories: [] }],
    ['a category that is never fixed', { fixCategories: ['flaky'] }],
    ['a confidence floor below the minimum', { minFixConfidence: 0.1 }],
    ['a fractional attempt count', { maxCiFixAttempts: 1.5 }],
    ['too many attempts', { maxCiFixAttempts: 6 }],
  ])('refuses %s', (_label, over) => {
    expect(
      CiTriagePayloadSchema.safeParse({
        baseBranch: 'main',
        connectionId: '11111111-1111-4111-8111-111111111111',
        githubRunId: '1',
        runAttempt: 1,
        ...over,
      }).success
    ).toBe(false);
  });
});
