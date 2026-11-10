import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { ciWaitEntry, failureLesson, prResult, qualityGate, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

/**
 * Tailored for dependency bumps: implement → full test suite → open PR → CI loop.
 * Skips the expensive review network (the diff is typically mechanical); tests
 * and CI are the real quality gate. Up to 3 CI-fix attempts before giving up.
 */
export const DEPENDENCY_UPDATE_SPEC: WorkflowSpec = {
  description:
    'Implement the dependency update, run the full test suite, open a pull request, then ' +
    'fix CI failures from the logs and push, up to 3 times. Skips the agent review: tests ' +
    'and CI are the quality gate for mechanical dependency bumps.',
  entry: 'validate',
  name: 'dependency-update',
  ...authored(
    macro('validate', 'validatePhase@1', { next: 'implement', successCriteria: false }),
    {
      implement: {
        group: 'implement',
        next: 'runTests',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
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
