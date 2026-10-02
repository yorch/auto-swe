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
 * Show the diff to a human reviewer; optionally apply their feedback before PR.
 */
export const HUMAN_CODE_REVIEW_SPEC: WorkflowSpec = {
  description:
    'Implement, lint, typecheck, then show the diff to a human reviewer before opening the PR. ' +
    'The reviewer can leave notes and the agent will address them, or approve the diff as-is.',
  entry: 'setValidating',
  name: 'human-code-review',
  nodes: {
    ...validatePhase({ next: 'setImplementing', successCriteria: false }),

    setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
    implement: {
      group: 'implement',
      next: 'runLint',
      step: 'executeImplementation',
      title: 'Implement the ticket',
      type: 'step',
    },
    runLint: qualityGate('runLint', 'runTypecheck', { group: 'implement' }),
    runTypecheck: qualityGate('runTypecheck', 'storeCodeResult', { group: 'implement' }),
    storeCodeResult: storeCodeResult('humanReview', { group: 'implement' }),

    humanReview: {
      contentFrom: 'context.currentCodeResult.diff',
      description: 'Review the diff and leave notes for the agent. Submit to continue.',
      group: 'human review',
      onSubmit: 'storeFeedback',
      onTimeout: 'openPR',
      storeAs: 'context.reviewFeedback',
      timeout: '8h',
      title: 'Review the implementation diff',
      type: 'humanReview',
    },
    storeFeedback: {
      group: 'human review',
      next: 'applyFeedbackDecision',
      title: 'Keep the reviewer notes',
      type: 'set',
      values: { 'context.reviewFeedback': { from: 'nodes.humanReview.output.feedback' } },
    },
    applyFeedbackDecision: {
      group: 'human review',
      onTimeout: 'openPR',
      options: [
        { label: 'Yes — apply the notes', next: 'addressFeedback', value: 'apply' },
        { label: 'No — looks good, open PR', next: 'openPR', value: 'skip' },
      ],
      timeout: '30m',
      title: 'Apply the reviewer notes before opening the PR?',
      type: 'humanDecision',
    },
    addressFeedback: {
      group: 'human review',
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: { from: 'context.reviewFeedback' },
      },
      next: 'updateCodeAfterFeedback',
      step: 'executeReviewFixImplementation',
      title: 'Address the reviewer notes',
      type: 'step',
    },
    updateCodeAfterFeedback: {
      group: 'human review',
      next: 'openPR',
      title: 'Keep the revised code',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.addressFeedback.output' } },
    },

    ...openPullRequest({ next: 'done' }),
    done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
