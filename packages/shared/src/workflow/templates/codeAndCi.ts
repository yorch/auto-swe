import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { ciWaitEntry, failureLesson, prResult, qualityGate, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

/**
 * Fully automated fast path: implement → local quality gates → open PR → CI loop.
 * No review network, no HITL. Fastest possible route from ticket to open PR.
 */
export const CODE_AND_CI_SPEC: WorkflowSpec = {
  description:
    'Fully automated: implement the change, run lint, type checks and tests, open a pull ' +
    'request, then fix CI failures from the logs and push, up to 3 times. No agent review ' +
    'and no human approval. Use for low-risk, well-tested codebases.',
  entry: 'validate',
  name: 'code-and-ci',
  ...authored(
    macro('validate', 'validatePhase@1', { next: 'implement', successCriteria: false }),
    {
      implement: {
        group: 'implement',
        next: 'runLint',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
      runLint: qualityGate('runLint', 'runTypecheck', { group: 'verify' }),
      runTypecheck: qualityGate('runTypecheck', 'runTests', { group: 'verify' }),
      runTests: qualityGate('runTests', 'openPR', { group: 'verify' }),
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
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
