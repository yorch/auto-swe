import type { Node } from '../../spec.js';
import type { Presentation } from './common.js';

/** The loop outcomes a failure lesson records. */
export type FailureLessonOutcome = 'REVIEW_FAILED' | 'CI_FAILED';

/**
 * A `commitToMemory` step that stores a lesson about a loop that ran out of
 * attempts, then goes on to `next` (the loop's FAILED terminal). Wire it as the
 * loop's `exhausted` target.
 *
 * Best-effort: `onError: 'continue'`, so a failed write never changes how the
 * run ends. The step reads its evidence from the context the review and CI
 * loops keep (`context.lastRejectionSummary`, `context.lastCILogs`,
 * `context.currentCodeResult`); the outcome is the only input it takes.
 */
export function failureLesson(
  outcome: FailureLessonOutcome,
  next: string,
  p: Presentation = {}
): Node {
  return {
    ...(p.group !== undefined ? { group: p.group } : {}),
    inputs: { outcome: { literal: outcome } },
    next,
    onError: 'continue',
    step: 'commitToMemory',
    title:
      p.title ??
      (outcome === 'REVIEW_FAILED' ? 'Store what the review rejected' : 'Store what failed CI'),
    type: 'step',
  };
}
