import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciLoop,
  ciWaitEntry,
  mergeNodes,
  openPullRequest,
  prResult,
  qualityGate,
  statusStamp,
  storeCodeResult,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * Fully automated fast path: implement → local quality gates → open PR → CI loop.
 * No review network, no HITL. Fastest possible route from ticket to open PR.
 */
export const CODE_AND_CI_SPEC: WorkflowSpec = {
  description:
    'Fully automated: implement, run lint + typecheck + tests locally, open a PR, ' +
    'then loop on CI failures (fetch logs → fix → push) up to 3 times. ' +
    'No review network, no human approval. Use for low-risk, well-tested codebases.',
  entry: 'setValidating',
  name: 'code-and-ci',
  nodes: mergeNodes(
    validatePhase({ next: 'setImplementing', successCriteria: false }),
    {
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
      implement: {
        group: 'implement',
        next: 'storeCodeResult',
        step: 'executeImplementation',
        title: 'Implement the ticket',
        type: 'step',
      },
      storeCodeResult: storeCodeResult('runLint', { group: 'implement' }),
      runLint: qualityGate('runLint', 'runTypecheck', { group: 'verify' }),
      runTypecheck: qualityGate('runTypecheck', 'runTests', { group: 'verify' }),
      runTests: qualityGate('runTests', 'openPR', { group: 'verify' }),
    },
    // This template has no initCounters, so recording the PR also zeroes the CI counter.
    openPullRequest({ next: ciWaitEntry(), resetCiRetries: true }),
    ciLoop({
      fix: { handoff: { repush: 'repushAfterFix' } },
      passed: 'done',
    }),
    {
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
