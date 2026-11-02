import type { OpenQuestionNote } from '@auto-swe/shared/types/workflow';

/**
 * What the implementer said, in the closing lines of its last message, about each open question of
 * the ticket (`criteriaContext.ts` asks for them): `Q1: left unchanged` or
 * `Q2: implemented - what it did`. The text is model output, so the parser is strict: only a line
 * of exactly that shape counts, a question number the prompt did not list is ignored, the note is
 * one bounded line with no control characters, and what is not understood is dropped, never
 * guessed at. The last line for a question wins, since the closing statement is the final one.
 */

export const MAX_NOTE_CHARS = 300;

const LINE =
  /^[ \t]*(?:[-*][ \t]+)?Q(\d{1,2})[ \t]*:[ \t]*(left unchanged|implemented)\b[ \t]*[-–—:]*[ \t]*(.*)$/gim;

const MAX_NOTES = 10;

/**
 * The notes of a stored `CodeResult`, re-checked on the way into the brief: a step's outputs are
 * JSON that earlier code wrote, so nothing about their shape is assumed.
 */
export function validOpenQuestionNotes(value: unknown): OpenQuestionNote[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: OpenQuestionNote[] = [];
  for (const item of value.slice(0, MAX_NOTES) as Record<string, unknown>[]) {
    const { note, question, resolution } = item ?? {};
    if (
      typeof question === 'string' &&
      typeof note === 'string' &&
      (resolution === 'implemented' || resolution === 'left-unchanged')
    ) {
      out.push({ note: note.slice(0, MAX_NOTE_CHARS), question, resolution });
    }
  }
  return out;
}

export function parseOpenQuestionNotes(
  text: string | undefined,
  questions: readonly string[]
): OpenQuestionNote[] {
  if (!text || questions.length === 0) {
    return [];
  }
  const byNumber = new Map<number, OpenQuestionNote>();
  for (const match of text.matchAll(LINE)) {
    const number = Number(match[1]);
    const question = questions[number - 1];
    if (question === undefined) {
      continue;
    }
    const flat = (match[3] ?? '').replace(/\s+/g, ' ').trim();
    const note =
      flat.length > MAX_NOTE_CHARS ? `${flat.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : flat;
    const left = (match[2] ?? '').toLowerCase() === 'left unchanged';
    byNumber.set(number, {
      note: left ? '' : note,
      question,
      resolution: left ? 'left-unchanged' : 'implemented',
    });
  }
  return [...byNumber.entries()].sort(([a], [b]) => a - b).map(([, note]) => note);
}
