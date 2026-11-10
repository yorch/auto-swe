import { describe, expect, it } from 'vitest';
import {
  AskUserQuestionInputSchema,
  isNeedsInput,
  MAX_RESUME_DIGEST_CHARS,
  NeedsInputQuestionSchema,
  ResumeInputSchema,
} from './needsInput.js';

const question = {
  header: 'Library',
  options: [{ description: 'fast', label: 'A' }, { label: 'B' }],
  question: 'Which one?',
};
const resume = {
  asked: [{ header: 'Library', question: 'Which one?' }],
  digest: 'did things',
  snapshot: null,
  version: 1,
};
const pause = { needsInput: { questions: [question], resume } };

describe('NeedsInputQuestionSchema', () => {
  it('defaults multiSelect and a missing option description', () => {
    const parsed = NeedsInputQuestionSchema.parse(question);
    expect(parsed.multiSelect).toBe(false);
    expect(parsed.options[1]?.description).toBe('');
  });

  it.each([
    ['empty question', { ...question, question: '' }],
    ['long question', { ...question, question: 'x'.repeat(501) }],
    ['long header', { ...question, header: 'x'.repeat(13) }],
    ['one option', { ...question, options: [{ label: 'A' }] }],
    ['five options', { ...question, options: Array.from({ length: 5 }, () => ({ label: 'A' })) }],
    ['empty label', { ...question, options: [{ label: '' }, { label: 'B' }] }],
    ['long label', { ...question, options: [{ label: 'x'.repeat(101) }, { label: 'B' }] }],
    [
      'long description',
      { ...question, options: [{ description: 'x'.repeat(501), label: 'A' }, { label: 'B' }] },
    ],
  ])('refuses %s', (_name, input) => {
    expect(NeedsInputQuestionSchema.safeParse(input).success).toBe(false);
  });

  it('bounds the question count of a tool input to 1..4', () => {
    expect(AskUserQuestionInputSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(
      AskUserQuestionInputSchema.safeParse({ questions: Array(5).fill(question) }).success
    ).toBe(false);
    expect(AskUserQuestionInputSchema.safeParse({ questions: [question] }).success).toBe(true);
  });
});

describe('isNeedsInput', () => {
  it('accepts a well-formed pause', () => {
    expect(isNeedsInput(pause)).toBe(true);
  });

  it('accepts a snapshot and a surface payload', () => {
    const snapshot = {
      artifactId: 'a1',
      baseSha: 'a'.repeat(40),
      bytes: 10,
      sha256: 'b'.repeat(64),
    };
    expect(
      isNeedsInput({
        needsInput: {
          questions: [question],
          resume: { ...resume, snapshot, surface: { iteration: 2 } },
        },
      })
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'needsInput'],
    ['an ordinary result', { text: 'done' }],
    ['no questions', { needsInput: { questions: [], resume } }],
    ['too many questions', { needsInput: { questions: Array(5).fill(question), resume } }],
    [
      'an unknown version',
      { needsInput: { questions: [question], resume: { ...resume, version: 2 } } },
    ],
    [
      'no version',
      { needsInput: { questions: [question], resume: { ...resume, version: undefined } } },
    ],
    [
      'an oversized digest',
      {
        needsInput: {
          questions: [question],
          resume: { ...resume, digest: 'x'.repeat(MAX_RESUME_DIGEST_CHARS + 1) },
        },
      },
    ],
    [
      'an unknown resume key',
      { needsInput: { questions: [question], resume: { ...resume, extra: 1 } } },
    ],
    [
      'a bad sha256',
      {
        needsInput: {
          questions: [question],
          resume: {
            ...resume,
            snapshot: { artifactId: 'a', baseSha: 'abc1234', bytes: 1, sha256: 'zz' },
          },
        },
      },
    ],
    [
      'an oversized surface',
      {
        needsInput: {
          questions: [question],
          resume: { ...resume, surface: { big: 'x'.repeat(20_000) } },
        },
      },
    ],
    ['a string needsInput', { needsInput: 'please' }],
  ])('refuses %s', (_name, input) => {
    expect(isNeedsInput(input)).toBe(false);
  });
});

describe('ResumeInputSchema', () => {
  it('accepts string and string[] answers', () => {
    const input = {
      answers: [
        { answer: 'A', question: 'Which one?' },
        { answer: ['A', 'B'], question: 'Which more?' },
      ],
      resume,
      round: 1,
    };
    expect(ResumeInputSchema.safeParse(input).success).toBe(true);
  });

  it('refuses round 0, a long answer and an unknown version', () => {
    expect(ResumeInputSchema.safeParse({ answers: [], resume, round: 0 }).success).toBe(false);
    expect(
      ResumeInputSchema.safeParse({
        answers: [{ answer: 'x'.repeat(2001), question: 'q' }],
        resume,
        round: 1,
      }).success
    ).toBe(false);
    expect(
      ResumeInputSchema.safeParse({ answers: [], resume: { ...resume, version: 9 }, round: 1 })
        .success
    ).toBe(false);
  });
});
