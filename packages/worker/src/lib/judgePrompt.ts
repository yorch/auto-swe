/**
 * Judge prompt assembly + the implementer/rubric wall — P2 of the evals feature
 * (docs/evals-p2.md WS2/WS6, RFC §9).
 *
 * Pure, unit-tested. Two responsibilities:
 *  - Build a judge prompt. Pairwise (relative, default) when a baseline is
 *    present — where moderate-κ judges are usable; pointwise (absolute) only for
 *    ranking, not gating.
 *  - Enforce the wall: golden references and rubric text must NEVER appear in
 *    the implementer's context (reward-hacking guard). `assertNoRubricLeak`
 *    throws if they do — wire it into the implementer context-assembly path.
 */

export interface JudgeRequest {
  /** Rubric prompt text (the grading criteria). */
  rubric: string;
  /** The candidate output under evaluation (e.g. a diff). */
  candidate: string;
  /** When present, judge pairwise (candidate vs. baseline) — the default. */
  baseline?: string;
}

const PAIRWISE_INSTRUCTION =
  'Compare CANDIDATE against BASELINE on the rubric below. Respond with a JSON object ' +
  '{ "winner": "candidate" | "baseline" | "tie", "score": 0..1, "rationale": string } ' +
  "where score is the candidate's quality relative to baseline (0.5 = tie).";

const POINTWISE_INSTRUCTION =
  'Score CANDIDATE on the rubric below. Respond with a JSON object ' +
  '{ "score": 0..1, "rationale": string }. This absolute score is advisory (for ranking), not a gate.';

export function buildJudgePrompt(req: JudgeRequest): {
  system: string;
  user: string;
  pairwise: boolean;
} {
  const pairwise = req.baseline !== undefined;
  const system = `You are an impartial code-review judge. ${
    pairwise ? PAIRWISE_INSTRUCTION : POINTWISE_INSTRUCTION
  }\n\nRUBRIC:\n${req.rubric}`;
  const user = pairwise
    ? `BASELINE:\n${req.baseline}\n\nCANDIDATE:\n${req.candidate}`
    : `CANDIDATE:\n${req.candidate}`;
  return { pairwise, system, user };
}

export interface WallViolation {
  kind: 'rubric' | 'reference';
  snippet: string;
}

/**
 * The implementer/rubric wall: scan a string about to be injected into the
 * implementer's context and report any rubric text or golden reference that
 * leaked in. A non-empty result means the answer key would be visible to the
 * agent being evaluated — a reward-hacking hole. Callers should treat any
 * violation as fatal.
 *
 * Matching is substring-based on normalized whitespace; we look for
 * sufficiently long fragments (>= `minFragment` chars) of the protected text so
 * incidental short overlaps (common code tokens) don't false-positive.
 */
export function findRubricLeak(
  implementerContext: string,
  protectedTexts: { rubric?: string; references?: string[] },
  minFragment = 24
): WallViolation[] {
  const haystack = normalize(implementerContext);
  const violations: WallViolation[] = [];
  const check = (kind: WallViolation['kind'], text: string | undefined) => {
    if (!text) {
      return;
    }
    const needle = normalize(text);
    // A protected text shorter than the fragment floor is matched whole.
    if (needle.length <= minFragment) {
      if (haystack.includes(needle)) {
        violations.push({ kind, snippet: needle });
      }
      return;
    }
    // Sliding window (step 1) so an unaligned contiguous overlap of at least
    // `minFragment` chars is caught regardless of where it falls.
    for (let i = 0; i + minFragment <= needle.length; i += 1) {
      const frag = needle.slice(i, i + minFragment);
      if (haystack.includes(frag)) {
        violations.push({ kind, snippet: frag });
        return; // one hit per protected text is enough
      }
    }
  };
  check('rubric', protectedTexts.rubric);
  for (const ref of protectedTexts.references ?? []) {
    check('reference', ref);
  }
  return violations;
}

/** Throwing variant for the context-assembly path. */
export function assertNoRubricLeak(
  implementerContext: string,
  protectedTexts: { rubric?: string; references?: string[] }
): void {
  const violations = findRubricLeak(implementerContext, protectedTexts);
  if (violations.length > 0) {
    throw new Error(
      `implementer/rubric wall breached: ${violations.map((v) => v.kind).join(', ')} text leaked into implementer context`
    );
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
