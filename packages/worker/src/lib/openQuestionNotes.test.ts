import { describe, expect, it } from 'vitest';
import {
  MAX_NOTE_CHARS,
  parseOpenQuestionNotes,
  validOpenQuestionNotes,
} from './openQuestionNotes.js';

const QUESTIONS = ['does it need auth?', 'which table?', 'what is the limit?'];

describe('parseOpenQuestionNotes', () => {
  it('reads one line per question from the closing lines', () => {
    const text = [
      'I added the endpoint and its test.',
      '',
      'Q1: left unchanged',
      'Q2: implemented - used the orders table because the ticket links to it',
      'Q3: implemented',
    ].join('\n');
    expect(parseOpenQuestionNotes(text, QUESTIONS)).toEqual([
      { note: '', question: 'does it need auth?', resolution: 'left-unchanged' },
      {
        note: 'used the orders table because the ticket links to it',
        question: 'which table?',
        resolution: 'implemented',
      },
      { note: '', question: 'what is the limit?', resolution: 'implemented' },
    ]);
  });

  it('accepts bullets, other dashes and any letter case', () => {
    const text =
      '- q1: LEFT UNCHANGED\n* Q2: Implemented – with a dash\nQ3: implemented: with a colon';
    expect(parseOpenQuestionNotes(text, QUESTIONS).map((n) => [n.resolution, n.note])).toEqual([
      ['left-unchanged', ''],
      ['implemented', 'with a dash'],
      ['implemented', 'with a colon'],
    ]);
  });

  it('lets the last line for a question win', () => {
    const text = 'Q1: left unchanged\nsome work\nQ1: implemented - changed my mind';
    expect(parseOpenQuestionNotes(text, QUESTIONS)).toEqual([
      { note: 'changed my mind', question: 'does it need auth?', resolution: 'implemented' },
    ]);
  });

  it('ignores a question number the prompt did not list, and lines of any other shape', () => {
    const text = [
      'Q4: implemented - there is no fourth',
      'Q0: left unchanged',
      'Q1 left unchanged',
      'Q1: maybe',
      'We answered Q1: left unchanged in the thread',
      'Q2: implementedly',
    ].join('\n');
    expect(parseOpenQuestionNotes(text, QUESTIONS)).toEqual([]);
  });

  it('keeps a note on one bounded line', () => {
    const [note] = parseOpenQuestionNotes(
      `Q1: implemented - first\tpart\nsecond line ${'x'.repeat(1000)}`,
      QUESTIONS
    );
    expect(note?.note).toBe('first part');
    const [long] = parseOpenQuestionNotes(`Q1: implemented - ${'y'.repeat(1000)}`, QUESTIONS);
    expect(long?.note.length).toBe(MAX_NOTE_CHARS);
    expect(long?.note.endsWith('…')).toBe(true);
  });

  it('gives nothing without text or without questions', () => {
    expect(parseOpenQuestionNotes(undefined, QUESTIONS)).toEqual([]);
    expect(parseOpenQuestionNotes('', QUESTIONS)).toEqual([]);
    expect(parseOpenQuestionNotes('Q1: left unchanged', [])).toEqual([]);
  });
});

describe('validOpenQuestionNotes', () => {
  it('keeps well-formed stored notes and drops everything else', () => {
    const stored = [
      { note: 'did it', question: 'which table?', resolution: 'implemented' },
      { note: '', question: 'auth?', resolution: 'left-unchanged' },
      { note: 'x', question: 'bad resolution', resolution: 'maybe' },
      { note: 5, question: 'bad note', resolution: 'implemented' },
      { note: 'x', question: 7, resolution: 'implemented' },
      null,
      'text',
    ];
    expect(validOpenQuestionNotes(stored)).toEqual([
      { note: 'did it', question: 'which table?', resolution: 'implemented' },
      { note: '', question: 'auth?', resolution: 'left-unchanged' },
    ]);
  });

  it('is empty for anything that is not a list, and bounds the list and each note', () => {
    for (const value of [undefined, null, 'x', 3, {}]) {
      expect(validOpenQuestionNotes(value)).toEqual([]);
    }
    const many = Array.from({ length: 30 }, (_, i) => ({
      note: 'n'.repeat(1000),
      question: `q${i}`,
      resolution: 'implemented',
    }));
    const kept = validOpenQuestionNotes(many);
    expect(kept).toHaveLength(10);
    expect(kept[0]?.note).toHaveLength(MAX_NOTE_CHARS);
  });
});
