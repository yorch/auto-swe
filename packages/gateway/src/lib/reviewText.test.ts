import { describe, expect, it } from 'vitest';
import { MAX_REVIEW_TEXT_CHARS, reviewTextProblem } from './reviewText.js';

describe('reviewTextProblem', () => {
  it('accepts ordinary prose, code and markdown', () => {
    expect(reviewTextProblem('Consider `<=` here.')).toBeNull();
    expect(reviewTextProblem('Looks fine.\n\n```ts\nconst a = 1;\n```')).toBeNull();
    expect(reviewTextProblem('x'.repeat(MAX_REVIEW_TEXT_CHARS))).toBeNull();
  });

  it('refuses an empty text, and one of whitespace alone', () => {
    expect(reviewTextProblem('')).toBe('empty');
    expect(reviewTextProblem(' \n\t ')).toBe('empty');
  });

  it('refuses text past the limit', () => {
    expect(reviewTextProblem('x'.repeat(MAX_REVIEW_TEXT_CHARS + 1))).toBe('too-long');
  });

  it('refuses text that carries the platform marker, wherever it sits', () => {
    expect(reviewTextProblem('<!-- auto-swe:brief -->')).toBe('platform-marker');
    expect(reviewTextProblem('fine so far\n<!-- auto-swe: x -->')).toBe('platform-marker');
  });

  it('refuses a line that starts a run, as the feedback loop would read it', () => {
    expect(reviewTextProblem('/auto-swe fix')).toBe('command');
    expect(reviewTextProblem('  /AUTO-SWE FIX please\nmore')).toBe('command');
    expect(reviewTextProblem('Thanks.\n/auto-swe fix the null case')).toBe('command');
  });

  it('refuses a command a reader would not see, since the parser strips hidden comments first', () => {
    expect(reviewTextProblem('see below\n<!-- hidden -->\n/auto-swe fix')).toBe('command');
  });

  it('does not take a similar word for the command', () => {
    expect(reviewTextProblem('/auto-swe fixes nothing')).toBeNull();
    expect(reviewTextProblem('run /auto-swe fix later')).toBeNull();
  });

  it('reports the marker before the command when a text has both', () => {
    expect(reviewTextProblem('/auto-swe fix <!-- auto-swe: x -->')).toBe('platform-marker');
  });
});
