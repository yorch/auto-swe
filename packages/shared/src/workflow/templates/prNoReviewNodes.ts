import type { WorkflowSpec } from '../spec.js';
import { ciWaitEntry, failureLesson, prResult, qualityGate, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

type QualityGateStep = 'runLint' | 'runTypecheck' | 'runTests';

/**
 * The graph shared by the templates that go from ticket to a pull request with no agent review and
 * no human approval: validate → implement → local quality gates → open the PR → CI loop.
 *
 * The templates differ only in which local gates run, in the order given: the first is where
 * `implement` goes next, each hands on to the next, and the last hands on to `openPR`.
 * Returns the `nodes` (and `uses`) to spread into the spec, so each template keeps its own name,
 * description and file.
 */
export function prWithoutReviewNodes(
  gates: readonly [QualityGateStep, ...QualityGateStep[]]
): Pick<WorkflowSpec, 'nodes' | 'uses'> {
  const gateNodes = Object.fromEntries(
    gates.map((gate, i) => [gate, qualityGate(gate, gates[i + 1] ?? 'openPR', { group: 'verify' })])
  );
  return authored(
    macro('validate', 'validatePhase@1', { next: 'implement', successCriteria: false }),
    {
      implement: {
        group: 'implement',
        next: gates[0],
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
      ...gateNodes,
    },
    macro('pr', 'openPullRequest@1', { next: ciWaitEntry() }),
    macro('ci', 'ciLoop@1', {
      exhausted: 'lessonCIFailed',
      fix: { handoff: { repush: 'repushAfterFix' } },
      passed: 'done',
    }),
    {
      // CI that runs out of fix attempts stores what failed before the run fails.
      lessonCIFailed: failureLesson('CI_FAILED', 'terminateCIFailed', { group: 'CI loop' }),
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
    }
  );
}
