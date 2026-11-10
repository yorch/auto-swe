import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciLoop,
  ciWaitEntry,
  failureLesson,
  mergeNodes,
  openPullRequest,
  prResult,
  qualityGate,
  terminate,
  validatePhase,
} from './authoring/index.js';

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
  nodes: mergeNodes(
    validatePhase({ next: 'implement', successCriteria: false }),
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
    openPullRequest({ next: ciWaitEntry() }),
    ciLoop({
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
