/**
 * The ambiguity convention of the `validateContext` agent: the built-in
 * `context-ambiguity-resolution` skill (shared/src/skills/contextAmbiguityResolution.ts) tells it
 * to write each ambiguity as a criterion of the form `AMBIGUOUS: <what is unclear>`, and the
 * validator prompt (shared/src/lib/agentPrompts.ts) tells it to do the same for input too vague to
 * extract criteria from. Keep the marker in step with those texts. This is the one place the
 * convention is read. `Clarify:` is accepted as an alias: the `success-criteria-extraction`
 * skill once gave it as the example, and a model following that text must not slip an open
 * question past the stop as if it were a concrete criterion.
 */

/** At most this many ambiguities, each at most this many characters, reach the run result. */
export const MAX_AMBIGUITIES = 10;
export const MAX_AMBIGUITY_CHARS = 500;
export const NO_REASON_GIVEN = 'no reason given';
export const NO_CRITERIA_REASON = 'validation could not extract any verifiable criteria';

/**
 * The marker at the start of an entry, after the decoration a model puts round it: backticks,
 * emphasis marks, a bullet or a list number. Case-insensitive; the separator is a colon, an em or
 * en dash, or a spaced hyphen, so a word that merely starts with it (`AMBIGUOUS-looking`) is not one.
 * `Clarify` is the alias, and shares the shape.
 */
const MARKER_SHAPE = (word: string) =>
  new RegExp(
    `^[\\s\`*_>•-]*(?:\\d+[.)]\\s*)?[\`*_]*${word}[\`*_]*(?:\\s*:|\\s+[-—–](?=\\s)|[—–])[\`*_\\s]*`,
    'i'
  );
const AMBIGUITY_MARKER = MARKER_SHAPE('AMBIGUOUS');
const CLARIFY_MARKER = MARKER_SHAPE('CLARIFY');

/** A question ends in a question mark, however many quotes, brackets or emphasis marks close it. */
const ENDS_IN_QUESTION = /\?[`*_"'”’)\]\s]*$/;

/** The backticks or emphasis marks that close a decorated entry. */
const CLOSING_DECORATION = /[`*_\s]+$/;

export interface SplitCriteria {
  /** The criteria that state a verifiable outcome, in order. */
  concrete: string[];
  /** The ambiguities, marker removed, in order, bounded in count and length. */
  ambiguities: string[];
}

export interface CriteriaAssessment {
  /** False when validation found nothing to verify but ambiguities (or nothing at all). */
  actionable: boolean;
  /** The ambiguities, marker removed, in order, bounded in count and length. */
  ambiguities: string[];
}

function bounded(reason: string): string {
  if (reason === '') {
    return NO_REASON_GIVEN;
  }
  return reason.length > MAX_AMBIGUITY_CHARS
    ? `${reason.slice(0, MAX_AMBIGUITY_CHARS - 1).trimEnd()}…`
    : reason;
}

/**
 * The open question an entry states, marker removed, or null when it is a criterion. `AMBIGUOUS:`
 * is a question whatever follows it. `Clarify:` is one only when what follows is a question: a
 * concrete criterion can begin with the word (`Clarify: the error message when X is empty`).
 */
function questionOf(entry: string): string | null {
  if (AMBIGUITY_MARKER.test(entry)) {
    return entry.replace(AMBIGUITY_MARKER, '').replace(CLOSING_DECORATION, '');
  }
  if (CLARIFY_MARKER.test(entry)) {
    const rest = entry.replace(CLARIFY_MARKER, '');
    return ENDS_IN_QUESTION.test(rest) ? rest.replace(CLOSING_DECORATION, '') : null;
  }
  return null;
}

/** Separate the entries that are ambiguities from the ones that are criteria. */
export function splitSuccessCriteria(successCriteria: readonly string[]): SplitCriteria {
  const concrete: string[] = [];
  const ambiguities: string[] = [];
  for (const criterion of successCriteria) {
    const question = questionOf(criterion);
    if (question !== null) {
      ambiguities.push(question);
    } else if (criterion.trim() !== '') {
      concrete.push(criterion);
    }
  }
  return { ambiguities: ambiguities.slice(0, MAX_AMBIGUITIES).map(bounded), concrete };
}

/**
 * A request is not actionable when validation found nothing to verify but questions: either every
 * criterion is an ambiguity, or a successful extraction returned none (the prompt's answer to
 * input too vague to read). One real criterion beside some ambiguities is still actionable, since
 * the skill asks for an entry for any gap, including minor ones. A degraded extraction (the model
 * call failed) is not a verdict, so its empty list lets the run go on.
 */
export function assessSuccessCriteria(
  successCriteria: readonly string[],
  opts: { degraded?: boolean } = {}
): CriteriaAssessment {
  if (opts.degraded) {
    return { actionable: true, ambiguities: [] };
  }
  if (successCriteria.length === 0) {
    return { actionable: false, ambiguities: [NO_CRITERIA_REASON] };
  }
  const { ambiguities, concrete } = splitSuccessCriteria(successCriteria);
  if (concrete.length === 0 && ambiguities.length === 0) {
    return { actionable: false, ambiguities: [NO_CRITERIA_REASON] };
  }
  return { actionable: concrete.length > 0, ambiguities };
}
