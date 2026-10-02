import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
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
    'Fastest possible path from ticket to open PR. ' +
    'Implement, run lint + typecheck (in warn mode so they never block), ' +
    'then open the PR immediately — no review network, no CI wait, no human approval. ' +
    'Intended for P0 production incidents only.',
  entry: 'setValidating',
  name: 'hotfix',
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
    storeCodeResult: storeCodeResult('runLint', { group: 'implement' }),

    runLint: qualityGate('runLint', 'runTypecheck', { group: 'verify' }),
    runTypecheck: qualityGate('runTypecheck', 'openPR', { group: 'verify' }),

    ...openPullRequest({ next: 'done' }),
    done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
