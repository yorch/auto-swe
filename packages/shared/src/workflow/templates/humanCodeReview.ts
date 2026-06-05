import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Show the diff to a human reviewer; optionally apply their feedback before PR.
 */
export const HUMAN_CODE_REVIEW_SPEC: WorkflowSpec = {
  description:
    'Implement, lint, typecheck, then show the diff to a human reviewer before opening the PR. ' +
    'The reviewer can leave notes and the agent will address them, or approve the diff as-is.',
  entry: 'setValidating',
  name: 'human-code-review',
  nodes: {
    addressFeedback: {
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: { from: 'context.reviewFeedback' },
      },
      next: 'updateCodeAfterFeedback',
      step: 'executeReviewFixImplementation',
      type: 'step',
    },
    applyFeedbackDecision: {
      onTimeout: 'openPR',
      options: [
        { label: 'Yes — apply the notes', next: 'addressFeedback', value: 'apply' },
        { label: 'No — looks good, open PR', next: 'openPR', value: 'skip' },
      ],
      timeout: '30m',
      title: 'Apply the reviewer notes before opening the PR?',
      type: 'humanDecision',
    },
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    humanReview: {
      contentFrom: 'context.currentCodeResult.diff',
      description: 'Review the diff and leave notes for the agent. Submit to continue.',
      onSubmit: 'storeFeedback',
      onTimeout: 'openPR',
      storeAs: 'context.reviewFeedback',
      timeout: '8h',
      title: 'Review the implementation diff',
      type: 'humanReview',
    },
    implement: {
      next: 'runLint',
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
      next: 'storeCodeResult',
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
      next: 'humanReview',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    storeFeedback: {
      next: 'applyFeedbackDecision',
      type: 'set',
      values: { 'context.reviewFeedback': { from: 'nodes.humanReview.output.feedback' } },
    },
    updateCodeAfterFeedback: {
      next: 'openPR',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.addressFeedback.output' } },
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
