/**
 * The workflow half of ask-and-resume: turn an activity's pause into the fields of a
 * human step, and turn the person's submission back into the answers the activity
 * is resumed with.
 *
 * Isolate-safe: the workflow dispatcher imports this from the Temporal V8 isolate,
 * so it has no runtime imports at all (no zod, no Node). The shapes it checks are
 * the ones `needsInput.ts` defines and its tests assert the two agree.
 */

import type { NeedsInput, NeedsInputQuestion, ResumeAnswer } from './needsInput.js';

/** Pinned-settings keys, as the registry declares them. */
const KEY_TIMEOUT = 'workflow.needsInputTimeoutSeconds';
const KEY_ROUNDS = 'workflow.maxNeedsInputRounds';

export const DEFAULT_NEEDS_INPUT_TIMEOUT_SECONDS = 86_400;
export const DEFAULT_MAX_NEEDS_INPUT_ROUNDS = 5;

export interface NeedsInputLimits {
  maxRounds: number;
  timeoutSeconds: number;
}

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * The ask-and-resume bounds out of a run's pinned-settings snapshot. Anything missing or
 * malformed falls back to the default rather than failing the run: the snapshot is
 * optional (runs created before the settings existed carry none) and a workflow that
 * threw on that would be retried forever.
 */
export function readNeedsInputLimits(
  pinned: Record<string, unknown> | null | undefined
): NeedsInputLimits {
  const source = pinned && typeof pinned === 'object' ? pinned : {};
  const timeout = source[KEY_TIMEOUT];
  const rounds = source[KEY_ROUNDS];
  return {
    maxRounds: inRange(rounds, 1, 20) ? rounds : DEFAULT_MAX_NEEDS_INPUT_ROUNDS,
    timeoutSeconds: inRange(timeout, 60, 1_209_600) ? timeout : DEFAULT_NEEDS_INPUT_TIMEOUT_SECONDS,
  };
}

// ── The pause guard ─────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max;

function isQuestion(q: unknown): boolean {
  if (!isObject(q) || !isString(q.question, 1, 500) || !isString(q.header, 1, 12)) {
    return false;
  }
  if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') {
    return false;
  }
  const options = q.options;
  return (
    Array.isArray(options) &&
    options.length >= 2 &&
    options.length <= 4 &&
    options.every((o) => isObject(o) && isString(o.label, 1, 100))
  );
}

/**
 * Whether an activity's `result` is a pause: the same check as `isNeedsInput` in
 * `needsInput.ts` without the schema library, which the workflow isolate does not
 * carry. The activity validated the full shape before it returned it; this refuses
 * anything that is not recognisably one, so an ordinary result is never mistaken
 * for a pause and a malformed pause never reaches the answer mapping.
 */
export function isPauseResult(result: unknown): result is { needsInput: NeedsInput } {
  if (!isObject(result) || !isObject(result.needsInput)) {
    return false;
  }
  const { questions, resume } = result.needsInput;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
    return false;
  }
  if (!questions.every(isQuestion) || !isObject(resume)) {
    return false;
  }
  return (
    resume.version === 1 &&
    typeof resume.digest === 'string' &&
    Array.isArray(resume.asked) &&
    (resume.snapshot === null || isObject(resume.snapshot))
  );
}

// ── The human step ──────────────────────────────────────────────────────────────

/** The field key of the question at `index` (0-based). */
export const questionKey = (index: number): string => `q${index + 1}`;
/** The optional free-text field every ask carries. */
export const NOTE_KEY = 'note';
/** The question an unprompted note is recorded under. */
export const NOTE_QUESTION = 'Additional note from the person';

const MAX_ANSWER_CHARS = 2000;
const MAX_MULTI_ITEMS = 20;
const MULTI_HINT = ' (comma-separated)';
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_CONTEXT_CHARS = 8192;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

export interface AskField {
  key: string;
  label: string;
  options?: string[];
  required?: boolean;
  type: 'select' | 'text';
}

export interface AskStep {
  context: string;
  description: string;
  fields: AskField[];
}

/**
 * What the person sees. One field per question: a `select` of the option labels, or a
 * comma-separated `text` for a multi-select; then an optional `note`. The questions in
 * full, with each option's description, go in the description (a field label is capped
 * at 100 characters); the digest of the work so far is the context.
 */
export function buildAskStep(needsInput: NeedsInput): AskStep {
  const fields: AskField[] = needsInput.questions.map((q, i) =>
    q.multiSelect
      ? {
          key: questionKey(i),
          label: truncate(q.question, 100 - MULTI_HINT.length) + MULTI_HINT,
          required: true,
          type: 'text',
        }
      : {
          key: questionKey(i),
          label: truncate(q.question, 100),
          options: q.options.map((o) => o.label),
          required: true,
          type: 'select',
        }
  );
  fields.push({ key: NOTE_KEY, label: 'Anything else the agent should know', type: 'text' });
  const lines = needsInput.questions.flatMap((q, i) => [
    `${i + 1}. [${q.header}] ${q.question}${q.multiSelect ? ' (choose any, comma-separated)' : ''}`,
    ...q.options.map((o) => `   - ${o.label}${o.description ? `: ${o.description}` : ''}`),
  ]);
  return {
    context: truncate(needsInput.resume.digest, MAX_CONTEXT_CHARS),
    description: truncate(
      ['The agent stopped to ask before it goes on:', ...lines].join('\n'),
      MAX_DESCRIPTION_CHARS
    ),
    fields,
  };
}

// ── The answers ─────────────────────────────────────────────────────────────────

/**
 * `text` as the labels it names. Options whose label holds a comma are matched first, so
 * choosing one is not read as choosing two; the rest is split on commas and newlines.
 */
function splitChoices(text: string, options: readonly string[]): string[] {
  const picked: string[] = [];
  let rest = text;
  for (const label of options.filter((o) => o.includes(',')).sort((a, b) => b.length - a.length)) {
    if (rest.includes(label)) {
      picked.push(label);
      rest = rest.split(label).join(',');
    }
  }
  const items = [...picked, ...rest.split(/[,\n]/)].map((s) => s.trim()).filter((s) => s !== '');
  return [...new Set(items)].slice(0, MAX_MULTI_ITEMS).map((s) => truncate(s, MAX_ANSWER_CHARS));
}

/** Whether `text` names at least one choice, by the same split {@link splitChoices} applies. */
export const hasChoice = (text: string): boolean =>
  text.split(/[,\n]/).some((s) => s.trim() !== '');

/** Whether an ask step's field is the comma-separated text of a multi-select question. */
export const isMultiChoiceField = (field: { label: string; type: string }): boolean =>
  field.type === 'text' && field.label.endsWith(MULTI_HINT);

export type MappedAnswers = { answers: ResumeAnswer[]; ok: true } | { ok: false; reason: string };

/**
 * The submission of the ask's human step as the answers the activity resumes with.
 * `payload` is the signal body, `{ action?, value? }`, where `value` is an object keyed by
 * the field keys. Strict about what it needs and deaf to the rest: every question must be
 * answered, a single choice must be one of the options, text is cut to the answer cap,
 * a multi-select is split and capped, and keys the step never offered are ignored.
 */
export function mapAskAnswers(
  questions: readonly NeedsInputQuestion[],
  payload: unknown
): MappedAnswers {
  if (!isObject(payload) || (payload.action !== undefined && payload.action !== 'submit')) {
    return { ok: false, reason: 'the submission is not a form submission' };
  }
  const value = payload.value;
  if (!isObject(value)) {
    return { ok: false, reason: 'the submission carries no answers' };
  }
  const answers: ResumeAnswer[] = [];
  for (const [i, q] of questions.entries()) {
    const raw = value[questionKey(i)];
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, reason: `question ${i + 1} was not answered` };
    }
    if (q.multiSelect) {
      const choices = splitChoices(
        raw,
        q.options.map((o) => o.label)
      );
      if (choices.length === 0) {
        return { ok: false, reason: `question ${i + 1} was not answered` };
      }
      answers.push({ answer: choices, question: q.question });
    } else if (q.options.some((o) => o.label === raw)) {
      answers.push({ answer: raw, question: q.question });
    } else {
      return { ok: false, reason: `the answer to question ${i + 1} is not one of its options` };
    }
  }
  const note = value[NOTE_KEY];
  if (typeof note === 'string' && note.trim() !== '') {
    answers.push({ answer: truncate(note.trim(), MAX_ANSWER_CHARS), question: NOTE_QUESTION });
  }
  return { answers, ok: true };
}
