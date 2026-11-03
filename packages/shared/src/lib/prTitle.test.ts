import { describe, expect, it } from 'vitest';
import {
  CONVENTIONAL_COMMIT_TYPES,
  CONVENTIONAL_TITLE_MAX_LENGTH,
  formatConventionalTitle,
  isConventionalCommitType,
  isConventionalTitle,
  isPrTitleFormat,
} from './prTitle.js';

describe('isConventionalTitle', () => {
  it('accepts a type and a description', () => {
    expect(isConventionalTitle('feat: add a health endpoint')).toBe(true);
    expect(isConventionalTitle('fix(gateway): refuse a stale approval token')).toBe(true);
    expect(isConventionalTitle('refactor!: drop the v1 route')).toBe(true);
  });

  it.each([
    ['an unknown type', 'feature: add a thing'],
    ['no space after the colon', 'feat:add a thing'],
    ['an empty description', 'feat: '],
    ['no type', 'add a thing'],
    ['a title over the cap', `feat: ${'a'.repeat(CONVENTIONAL_TITLE_MAX_LENGTH)}`],
    ['a newline', 'feat: add a thing\nmore'],
  ])('rejects %s', (_label, title) => {
    expect(isConventionalTitle(title)).toBe(false);
  });
});

describe('formatConventionalTitle', () => {
  it('writes type: summary', () => {
    expect(
      formatConventionalTitle({
        fallbackSummary: 'x',
        summary: 'add a health endpoint',
        type: 'feat',
      })
    ).toBe('feat: add a health endpoint');
  });

  it('always produces a valid conventional title', () => {
    for (const type of CONVENTIONAL_COMMIT_TYPES) {
      const title = formatConventionalTitle({
        fallbackSummary: 'x',
        summary: 'Fix the thing. '.repeat(20),
        type,
      });
      expect(isConventionalTitle(title)).toBe(true);
    }
  });

  it('falls back to chore for an unknown or missing type', () => {
    expect(formatConventionalTitle({ fallbackSummary: 'x', summary: 'tidy up', type: 'wat' })).toBe(
      'chore: tidy up'
    );
    expect(
      formatConventionalTitle({ fallbackSummary: 'x', summary: 'tidy up', type: undefined })
    ).toBe('chore: tidy up');
  });

  it('drops a type prefix the model repeated and a trailing full stop', () => {
    expect(
      formatConventionalTitle({
        fallbackSummary: 'x',
        summary: 'feat(api): Add a route.',
        type: 'feat',
      })
    ).toBe('feat: add a route');
  });

  it('lowercases the first word but keeps an acronym or identifier', () => {
    expect(
      formatConventionalTitle({ fallbackSummary: 'x', summary: 'Add retries', type: 'feat' })
    ).toBe('feat: add retries');
    expect(
      formatConventionalTitle({ fallbackSummary: 'x', summary: 'API retries', type: 'feat' })
    ).toBe('feat: API retries');
    expect(
      formatConventionalTitle({ fallbackSummary: 'x', summary: 'JIRA-12 retries', type: 'fix' })
    ).toBe('fix: JIRA-12 retries');
  });

  it('collapses a multi-line summary to one line', () => {
    expect(
      formatConventionalTitle({
        fallbackSummary: 'x',
        summary: 'add a\n\nroute  now',
        type: 'feat',
      })
    ).toBe('feat: add a route now');
  });

  it('cuts a long summary at a word boundary inside the cap', () => {
    const title = formatConventionalTitle({
      fallbackSummary: 'x',
      summary: 'make the retry loop back off exponentially when the upstream reports a rate limit',
      type: 'perf',
    });
    expect(title.length).toBeLessThanOrEqual(CONVENTIONAL_TITLE_MAX_LENGTH);
    expect(title.startsWith('perf: make the retry loop')).toBe(true);
    expect(title.endsWith(' ')).toBe(false);
  });

  it('uses the fallback summary when the summary is empty, and a constant when both are', () => {
    expect(formatConventionalTitle({ fallbackSummary: 'JIRA-9', summary: '  ', type: 'fix' })).toBe(
      'fix: JIRA-9'
    );
    expect(formatConventionalTitle({ fallbackSummary: '', summary: '', type: 'fix' })).toBe(
      'fix: update'
    );
  });

  it('does not cut an emoji in half', () => {
    const title = formatConventionalTitle({
      fallbackSummary: 'x',
      summary: '🚀'.repeat(100),
      type: 'feat',
    });
    expect(Array.from(title).length).toBeLessThanOrEqual(CONVENTIONAL_TITLE_MAX_LENGTH);
    expect(title).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe('guards', () => {
  it('recognises the types and formats', () => {
    expect(isConventionalCommitType('feat')).toBe(true);
    expect(isConventionalCommitType('auto')).toBe(false);
    expect(isConventionalCommitType(undefined)).toBe(false);
    expect(isPrTitleFormat('conventional')).toBe(true);
    expect(isPrTitleFormat('inherit')).toBe(false);
  });
});
