/** A small spec built from two real macro uses, shared by the macro tests. */
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { expandUse, parseWorkflowSpec } from '@auto-swe/shared/workflow';

export const PR_USE = { args: { next: 'waitForCI' }, macro: 'openPullRequest@1' };
export const CI_USE = { args: { fix: false, passed: 'done' }, macro: 'ciLoop@1' };

/**
 * start -> [pr: openPR -> savePrInfo] -> [ci: waitForCI -> checkCI -> …] -> done.
 * The `pr` use is the `pull request` group; `ci` spans the `CI wait` and `CI loop` groups.
 */
export function macroSpec(
  ci: typeof CI_USE | { args: Record<string, unknown>; macro: string } = CI_USE
): WorkflowSpec {
  return parseWorkflowSpec({
    entry: 'start',
    name: 'macros',
    nodes: {
      start: { next: 'openPR', step: 'x', type: 'step' },
      ...expandUse('pr', PR_USE),
      ...expandUse('ci', ci),
      done: { status: 'SUCCESS', type: 'terminate' },
    },
    schemaVersion: 1,
    uses: { ci, pr: PR_USE },
  });
}
