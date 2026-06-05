import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Kitchen-sink supervised flow: all four HITL node types chained.
 * input → implement → review → decision → approve → PR.
 */
export const FULL_SUPERVISED_SPEC: WorkflowSpec = {
  description:
    'The kitchen-sink supervised workflow: collect requirements upfront, implement, ' +
    'show the diff for review, let the reviewer decide whether to apply their notes, ' +
    'then require final approval before the PR is opened. ' +
    'Demonstrates all four HITL node types in sequence.',
  entry: 'gatherContext',
  name: 'full-supervised',
  nodes: {
    addressNotes: {
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: { from: 'context.reviewNotes' },
      },
      next: 'updateCodeAfterNotes',
      step: 'executeReviewFixImplementation',
      type: 'step',
    },
    applyNotesDecision: {
      onTimeout: 'finalApproval',
      options: [
        { label: 'Yes — apply notes and re-review', next: 'addressNotes', value: 'apply' },
        { label: 'No — looks good', next: 'finalApproval', value: 'skip' },
      ],
      timeout: '30m',
      title: 'Apply the review notes?',
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
    finalApproval: {
      description: 'This will open a pull request that reviewers can see.',
      onApprove: 'openPR',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '24h',
      title: 'Final approval — open the PR?',
      type: 'humanApproval',
    },
    gatherContext: {
      description:
        'Your answers are passed directly to the agent. Leave fields blank to let the agent decide.',
      fields: [
        {
          key: 'approach',
          label: 'Preferred approach or constraints',
          required: false,
          type: 'text',
        },
        {
          key: 'relatedPRs',
          label: 'Related PR numbers to reference',
          required: false,
          type: 'text',
        },
        { key: 'testFocus', label: 'Areas to focus testing on', required: false, type: 'text' },
      ],
      onSubmit: 'storeContext',
      onTimeout: 'setImplementing',
      storeAs: 'context.requirements',
      timeout: '15m',
      title: 'Provide implementation context',
      type: 'humanInput',
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
    reviewDiff: {
      contentFrom: 'context.currentCodeResult.diff',
      description: 'Review the diff and leave notes. Submit when done.',
      onSubmit: 'storeReviewNotes',
      onTimeout: 'finalApproval',
      storeAs: 'context.reviewNotes',
      timeout: '8h',
      title: 'Review the implementation diff',
      type: 'humanReview',
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
    storeCodeResult: {
      next: 'reviewDiff',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    storeContext: {
      next: 'setImplementing',
      type: 'set',
      values: { 'context.requirements': { from: 'nodes.gatherContext.output.data' } },
    },
    storeReviewNotes: {
      next: 'applyNotesDecision',
      type: 'set',
      values: { 'context.reviewNotes': { from: 'nodes.reviewDiff.output.feedback' } },
    },
    terminateRejected: { status: 'FAILED', type: 'terminate' },
    terminateTimedOut: { status: 'TIMED_OUT', type: 'terminate' },
    updateCodeAfterNotes: {
      next: 'finalApproval',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.addressNotes.output' } },
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
