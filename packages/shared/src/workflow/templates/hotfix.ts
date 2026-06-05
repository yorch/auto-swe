import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

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
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    implement: {
      next: 'storeCodeResult',
      step: 'executeImplementation',
      type: 'step',
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    runLint: {
      next: 'runTypecheck',
      onFail: 'warn',
      step: 'runLint',
      type: 'step',
    },
    runTypecheck: {
      next: 'openPR',
      onFail: 'warn',
      step: 'runTypecheck',
      type: 'step',
    },
    savePrInfo: {
      next: 'done',
      type: 'set',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    setValidating: {
      config: { status: 'VALIDATING_CONTEXT' },
      next: 'validate',
      step: 'updateDomainState',
      type: 'step',
    },
    storeCodeResult: {
      next: 'runLint',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    validate: {
      next: 'setImplementing',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
