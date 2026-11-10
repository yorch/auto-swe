import { describe, expect, it } from 'vitest';
import { isNeedsInput, MAX_QUESTIONS, type NeedsInput, ResumeInputSchema } from './needsInput.js';
import {
  buildAskStep,
  hasChoice,
  isMultiChoiceField,
  isPauseResult,
  mapAskAnswers,
  NOTE_QUESTION,
  readNeedsInputLimits,
} from './needsInputAsk.js';

const single = {
  header: 'Library',
  multiSelect: false,
  options: [
    { description: 'fast', label: 'Alpha' },
    { description: '', label: 'Beta, the second' },
  ],
  question: 'Which library should it use?',
};
const multi = {
  header: 'Targets',
  multiSelect: true,
  options: [
    { description: '', label: 'Linux' },
    { description: '', label: 'Mac, arm' },
    { description: '', label: 'Windows' },
  ],
  question: 'Which targets?',
};
const needsInput: NeedsInput = {
  questions: [single, multi],
  resume: {
    asked: [
      { header: 'Library', question: single.question },
      { header: 'Targets', question: multi.question },
    ],
    digest: 'edited 2 files',
    snapshot: null,
    version: 1,
  },
};

describe('readNeedsInputLimits', () => {
  it('reads pinned values', () => {
    expect(
      readNeedsInputLimits({
        'workflow.maxNeedsInputRounds': 3,
        'workflow.needsInputTimeoutSeconds': 600,
      })
    ).toEqual({ maxRounds: 3, timeoutSeconds: 600 });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', {}],
    [
      'strings',
      { 'workflow.maxNeedsInputRounds': '3', 'workflow.needsInputTimeoutSeconds': '600' },
    ],
    [
      'out of range',
      { 'workflow.maxNeedsInputRounds': 0, 'workflow.needsInputTimeoutSeconds': 59 },
    ],
    [
      'too large',
      { 'workflow.maxNeedsInputRounds': 21, 'workflow.needsInputTimeoutSeconds': 1_209_601 },
    ],
    [
      'fractions',
      { 'workflow.maxNeedsInputRounds': 2.5, 'workflow.needsInputTimeoutSeconds': 90.5 },
    ],
  ])('falls back to the defaults for %s', (_name, pinned) => {
    expect(readNeedsInputLimits(pinned as Record<string, unknown> | null | undefined)).toEqual({
      maxRounds: 5,
      timeoutSeconds: 86_400,
    });
  });

  it('falls back per field', () => {
    expect(readNeedsInputLimits({ 'workflow.maxNeedsInputRounds': 7 })).toEqual({
      maxRounds: 7,
      timeoutSeconds: 86_400,
    });
  });
});

describe('isPauseResult', () => {
  it('agrees with isNeedsInput on well-formed and malformed results', () => {
    const cases: unknown[] = [
      { needsInput: needsInput },
      { needsInput: { ...needsInput, questions: [] } },
      { needsInput: { ...needsInput, questions: Array(5).fill(single) } },
      { needsInput: { ...needsInput, resume: { ...needsInput.resume, version: 2 } } },
      { needsInput: { ...needsInput, resume: { ...needsInput.resume, digest: 3 } } },
      { needsInput: { ...needsInput, resume: null } },
      {
        needsInput: {
          questions: [{ ...single, options: [single.options[0]] }],
          resume: needsInput.resume,
        },
      },
      {
        needsInput: {
          questions: [{ ...single, header: 'x'.repeat(13) }],
          resume: needsInput.resume,
        },
      },
      { needsInput: 'yes' },
      { text: 'done' },
      { ok: true },
      null,
      undefined,
      'needsInput',
      [],
    ];
    for (const c of cases) {
      expect(isPauseResult(c), JSON.stringify(c)?.slice(0, 80)).toBe(isNeedsInput(c));
    }
  });
});

describe('buildAskStep', () => {
  const step = buildAskStep(needsInput);

  it('makes a select per single question and a text per multi-select, then a note', () => {
    expect(step.fields.map((f) => [f.key, f.type, f.required ?? false])).toEqual([
      ['q1', 'select', true],
      ['q2', 'text', true],
      ['note', 'text', false],
    ]);
    expect(step.fields[0]?.options).toEqual(['Alpha', 'Beta, the second']);
    expect(step.fields[1]?.options).toBeUndefined();
    expect(step.fields[1]?.label.endsWith('(comma-separated)')).toBe(true);
  });

  it('keeps every label within the human step limit', () => {
    const long = buildAskStep({
      ...needsInput,
      questions: [
        { ...single, question: 'q'.repeat(500) },
        { ...multi, question: 'q'.repeat(500) },
      ],
    });
    for (const field of long.fields) {
      expect(field.label.length).toBeLessThanOrEqual(100);
    }
    expect(long.fields[1]?.label.endsWith('(comma-separated)')).toBe(true);
  });

  it('puts the questions in full in the description and the digest in the context', () => {
    expect(step.description).toContain('[Library] Which library should it use?');
    expect(step.description).toContain('- Alpha: fast');
    expect(step.description).toContain('- Beta, the second');
    expect(step.context).toBe('edited 2 files');
  });

  it('bounds the description and the context', () => {
    const big = buildAskStep({
      questions: Array.from({ length: 4 }, () => ({
        ...single,
        options: Array.from({ length: 4 }, () => ({ description: 'd'.repeat(500), label: 'L' })),
        question: 'q'.repeat(500),
      })),
      resume: { ...needsInput.resume, digest: 'd'.repeat(8192) },
    });
    expect(big.description.length).toBeLessThanOrEqual(4000);
    expect(big.context.length).toBeLessThanOrEqual(8192);
  });
});

describe('mapAskAnswers', () => {
  const submit = (value: unknown, action: string | undefined = 'submit') => ({ action, value });

  it('maps a single choice, a multi-select and a note', () => {
    const mapped = mapAskAnswers(
      needsInput.questions,
      submit({ note: ' use v2 ', q1: 'Alpha', q2: 'Linux, Windows' })
    );
    expect(mapped).toEqual({
      answers: [
        { answer: 'Alpha', question: single.question },
        { answer: ['Linux', 'Windows'], question: multi.question },
        { answer: 'use v2', question: NOTE_QUESTION },
      ],
      ok: true,
    });
  });

  it('accepts a signal without an action', () => {
    expect(
      mapAskAnswers(needsInput.questions, submit({ q1: 'Alpha', q2: 'Linux' }, undefined)).ok
    ).toBe(true);
  });

  it('reads an option whose label holds a comma as one choice', () => {
    const mapped = mapAskAnswers(
      needsInput.questions,
      submit({ q1: 'Alpha', q2: 'Mac, arm, Linux' })
    );
    expect(mapped).toMatchObject({ ok: true });
    expect(mapped.ok && mapped.answers[1]?.answer).toEqual(['Mac, arm', 'Linux']);
  });

  it('drops empty and repeated choices and caps their number', () => {
    const many = Array.from({ length: 40 }, (_, i) => `c${i}`).join(',');
    const mapped = mapAskAnswers(
      needsInput.questions,
      submit({ q1: 'Alpha', q2: `Linux,, Linux,${many}` })
    );
    expect(mapped.ok).toBe(true);
    const choices = mapped.ok ? (mapped.answers[1]?.answer ?? []) : [];
    expect(choices).toHaveLength(20);
    expect(choices[0]).toBe('Linux');
  });

  it('cuts overlong text and ignores unknown keys', () => {
    const mapped = mapAskAnswers(
      [multi],
      submit({ evil: 'x', note: 'n'.repeat(5000), q1: 'z'.repeat(5000), q9: 'x' })
    );
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.answers).toHaveLength(2);
      const [first, note] = mapped.answers.map((a) => a.answer);
      expect(String(Array.isArray(first) ? first[0] : first)).toHaveLength(2000);
      expect(String(note)).toHaveLength(2000);
      expect(JSON.stringify(mapped.answers)).not.toContain('evil');
    }
  });

  it.each([
    ['null payload', null],
    ['string payload', 'Alpha'],
    ['array payload', []],
    ['wrong action', { action: 'reject', value: { q1: 'Alpha', q2: 'Linux' } }],
    ['no value', { action: 'submit' }],
    ['value is an array', { action: 'submit', value: [] }],
    ['value is a string', { action: 'submit', value: 'Alpha' }],
    ['missing answer', submit({ q1: 'Alpha' })],
    ['blank answer', submit({ q1: 'Alpha', q2: '   ' })],
    ['only separators', submit({ q1: 'Alpha', q2: ' , ,\n' })],
    ['non-string answer', submit({ q1: 'Alpha', q2: 7 })],
    ['not an option', submit({ q1: 'Gamma', q2: 'Linux' })],
    ['option with wrong case', submit({ q1: 'alpha', q2: 'Linux' })],
  ])('refuses %s', (_name, payload) => {
    expect(mapAskAnswers(needsInput.questions, payload).ok).toBe(false);
  });

  it('records no note for a blank one', () => {
    const mapped = mapAskAnswers(
      needsInput.questions,
      submit({ note: '  ', q1: 'Alpha', q2: 'Linux' })
    );
    expect(mapped.ok && mapped.answers).toHaveLength(2);
  });
});

describe('answers at the maximum', () => {
  it('maps the most questions plus a note into a resume input the schema accepts', () => {
    const questions = Array.from({ length: MAX_QUESTIONS }, (_, i) => ({
      ...single,
      question: `Which library ${i}?`,
    }));
    const value: Record<string, string> = { note: 'and one more thing' };
    for (const i of questions.keys()) {
      value[`q${i + 1}`] = 'Alpha';
    }
    const mapped = mapAskAnswers(questions, { action: 'submit', value });
    if (!mapped.ok) {
      throw new Error(mapped.reason);
    }
    expect(mapped.answers).toHaveLength(MAX_QUESTIONS + 1);
    const resume = { ...needsInput.resume, asked: [] };
    expect(ResumeInputSchema.safeParse({ answers: mapped.answers, resume, round: 1 }).success).toBe(
      true
    );
  });
});

describe('multi-select field helpers', () => {
  it('knows the multi-select field of a built step', () => {
    const fields = buildAskStep(needsInput).fields;
    expect(fields.map((f) => isMultiChoiceField(f))).toEqual([false, true, false]);
  });

  it('counts a choice only when something is left after splitting', () => {
    expect(hasChoice(' , ,\n')).toBe(false);
    expect(hasChoice('')).toBe(false);
    expect(hasChoice(' a ,')).toBe(true);
  });
});
