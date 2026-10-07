import type { CodeResult, LessonEvidence, LessonOutcome } from '@auto-swe/shared/types/workflow';
import { rejectionText } from './rejectionText.js';

/**
 * Builds the evidence a run's lesson is written from, out of the workflow's own
 * context. Pure, and imports only pure modules, so the workflow isolate can call it.
 *
 * Every field is bounded: the result is an activity argument and lands in
 * workflow history, and CI logs or implementation notes can each run to
 * megabytes. Logs keep their tail — the failure is at the end — and prose keeps
 * its head.
 */

export const EVIDENCE_TEXT_LIMIT = 4_000;
export const EVIDENCE_FILE_LIMIT = 40;

const OUTCOMES: ReadonlySet<string> = new Set<LessonOutcome>([
  'MERGED',
  'REVIEW_FAILED',
  'CI_FAILED',
  'COMPLETED',
]);

export function buildLessonEvidence(input: {
  outcome: unknown;
  rejectionSummary: unknown;
  ciLogs: unknown;
  codeResult: unknown;
}): LessonEvidence {
  const outcome =
    typeof input.outcome === 'string' && OUTCOMES.has(input.outcome)
      ? (input.outcome as LessonOutcome)
      : 'COMPLETED';
  const evidence: LessonEvidence = { outcome };

  // Nothing clears the other loop's context, so a failed loop's lesson carries only its own
  // evidence: a rejection the review got past is not why CI failed. Any other outcome keeps
  // both, as what earlier attempts hit on the way.
  // A fan-out review keeps its per-branch results here rather than one summary.
  const rejection =
    outcome === 'CI_FAILED' ? undefined : head(rejectionText(input.rejectionSummary));
  if (rejection) {
    evidence.rejectionSummary = rejection;
  }
  const ci = outcome === 'REVIEW_FAILED' ? undefined : tail(input.ciLogs);
  if (ci) {
    evidence.ciFailure = ci;
  }
  const code = input.codeResult as Partial<CodeResult> | null | undefined;
  if (code && typeof code === 'object' && Array.isArray(code.filesChanged)) {
    const files = code.filesChanged;
    evidence.change = {
      filesChanged: files.slice(0, EVIDENCE_FILE_LIMIT).map((f) => ({
        linesAdded: f.linesAdded,
        linesRemoved: f.linesRemoved,
        operation: f.operation,
        path: f.path,
      })),
      filesOmitted: Math.max(0, files.length - EVIDENCE_FILE_LIMIT),
      headSha: typeof code.headSha === 'string' ? code.headSha : '',
      implementationNotes: head(code.implementationNotes) ?? '',
      tests: {
        failing: code.testResults?.failing ?? 0,
        passed: code.testResults?.passed ?? false,
        passing: code.testResults?.passing ?? 0,
        total: code.testResults?.total ?? 0,
      },
    };
  }
  return evidence;
}

function head(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.length > EVIDENCE_TEXT_LIMIT
    ? `${value.slice(0, EVIDENCE_TEXT_LIMIT)}\n[… ${value.length - EVIDENCE_TEXT_LIMIT} more characters]`
    : value;
}

function tail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.length > EVIDENCE_TEXT_LIMIT
    ? `[… ${value.length - EVIDENCE_TEXT_LIMIT} earlier characters]\n${value.slice(-EVIDENCE_TEXT_LIMIT)}`
    : value;
}
