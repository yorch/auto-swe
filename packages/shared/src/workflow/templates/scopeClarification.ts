import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Collects human guidance before implementation starts.
 * Ideal for vague tickets where the agent needs direction before acting.
 */
export const SCOPE_CLARIFICATION_SPEC: WorkflowSpec = {
  description:
    'Ask a human for additional context before the agent starts implementing. ' +
    'Useful for tickets whose descriptions are intentionally vague or too high-level for the agent to act on without guidance.',
  entry: 'clarify',
  name: 'scope-clarification',
  nodes: {
    checkApproval: {
      expr: 'nodes.review.output.approved == true',
      onFalse: 'incReviewRetries',
      onTrue: 'openPR',
      type: 'cond',
    },
    checkReviewLimit: {
      expr: 'context.reviewRetries >= 3',
      onFalse: 'reviewFix',
      onTrue: 'terminateReviewFailed',
      type: 'cond',
    },
    clarify: {
      description:
        'Answer as much or as little as you like. Leave fields blank to let the agent decide.',
      fields: [
        {
          key: 'approach',
          label: 'Preferred implementation approach',
          required: false,
          type: 'text',
        },
        {
          key: 'constraints',
          label: 'Constraints or things to avoid',
          required: false,
          type: 'text',
        },
        {
          key: 'testFocus',
          label: 'Areas to focus testing on',
          required: false,
          type: 'text',
        },
      ],
      onSubmit: 'storeClarification',
      onTimeout: 'setImplementing',
      storeAs: 'context.clarification',
      timeout: '30m',
      title: 'Clarify implementation requirements',
      type: 'humanInput',
    },
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    implement: {
      next: 'initCounters',
      step: 'executeImplementation',
      type: 'step',
    },
    incReviewRetries: {
      next: 'storeRejection',
      type: 'set',
      values: { 'context.reviewRetries': { expr: 'context.reviewRetries + 1' } },
    },
    initCounters: {
      next: 'setReviewing',
      type: 'set',
      values: {
        'context.currentCodeResult': { from: 'nodes.implement.output' },
        'context.reviewRetries': { literal: 0 },
      },
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'done',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    review: {
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
        successCriteria: { from: 'context.successCriteria' },
      },
      next: 'checkApproval',
      step: 'runReviewNetwork',
      type: 'step',
    },
    reviewFix: {
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: { from: 'context.lastRejectionSummary' },
      },
      next: 'updateCodeAfterFix',
      step: 'executeReviewFixImplementation',
      type: 'step',
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    setReviewing: {
      config: { status: 'IN_REVIEW' },
      next: 'review',
      step: 'updateDomainState',
      type: 'step',
    },
    storeClarification: {
      next: 'setImplementing',
      type: 'set',
      values: { 'context.clarification': { from: 'nodes.clarify.output.data' } },
    },
    storeRejection: {
      next: 'checkReviewLimit',
      type: 'set',
      values: {
        'context.lastRejectionSummary': {
          default: '',
          from: 'nodes.review.output.rejectionSummary',
        },
      },
    },
    successCriteria: {
      next: 'setImplementing',
      type: 'set',
      values: {
        'context.successCriteria': { default: [], from: 'nodes.validate.output.successCriteria' },
      },
    },
    terminateReviewFailed: { status: 'FAILED', type: 'terminate' },
    updateCodeAfterFix: {
      next: 'setReviewing',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.reviewFix.output' } },
    },
    validate: {
      next: 'successCriteria',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
