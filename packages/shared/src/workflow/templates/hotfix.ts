import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { prResult, qualityGate, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

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
  entry: 'validate',
  name: 'hotfix',
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
      runTypecheck: qualityGate('runTypecheck', 'openPR', { group: 'verify' }),
    },
    macro('pr', 'openPullRequest@1', { next: 'done' }),
    {
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
