import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciLoop,
  ciWaitEntry,
  openPullRequest,
  prResult,
  qualityGate,
  statusStamp,
  storeCodeResult,
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
    'Implement the dependency update, run the full test suite, open a PR, then loop ' +
    'on CI failures (fetch logs → fix → push) up to 3 times. ' +
    'Skips the review network — tests and CI are the quality gate for mechanical dep bumps.',
  entry: 'setValidating',
  name: 'dependency-update',
  nodes: {
    ...validatePhase({ next: 'setImplementing', successCriteria: false }),

    setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
    implement: {
      group: 'implement',
      next: 'storeCodeResult',
      step: 'executeImplementation',
      title: 'Implement the ticket',
      type: 'step',
    },
    storeCodeResult: storeCodeResult('runTests', { group: 'implement' }),

    runTests: qualityGate('runTests', 'openPR', { group: 'verify' }),

    // This template has no initCounters, so recording the PR also zeroes the CI counter.
    ...openPullRequest({ next: ciWaitEntry(), resetCiRetries: true }),
    ...ciLoop({
      fix: { handoff: { repush: 'repushAfterFix' } },
      passed: 'done',
    }),

    done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
