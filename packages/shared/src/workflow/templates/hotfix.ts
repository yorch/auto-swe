import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
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
 * Expedited P0 path: implement → lint → typecheck → open PR immediately.
 * No review network, no CI wait, no HITL. Use only for production incidents
 * where time-to-merge trumps quality gates.
 */
export const HOTFIX_SPEC: WorkflowSpec = {
  description:
    'The fastest path from ticket to open pull request. Implement, run lint and type checks ' +
    '(warnings never block), then open the pull request immediately: no agent review, no CI ' +
    'wait, no human approval. Intended for urgent production incidents only.',
  entry: 'setValidating',
  name: 'hotfix',
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
      runTypecheck: qualityGate('runTypecheck', 'openPR', { group: 'verify' }),
    },
    openPullRequest({ next: 'done' }),
    {
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
