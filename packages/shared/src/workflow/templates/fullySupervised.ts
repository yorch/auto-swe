import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, openPullRequest, prResult, terminate } from './authoring/index.js';

/**
 * Kitchen-sink supervised flow: all four HITL node types chained.
 * input → implement → review → decision → approve → PR.
 *
 * The final gate also offers request changes: a note sends the code back for a
 * fix (the same session that applies review notes) and straight back to the
 * gate, capped at three rounds — a third change request fails the run.
 */
export const FULLY_SUPERVISED_SPEC: WorkflowSpec = {
  description:
    'The most hands-on workflow: collect requirements up front, implement, show the diff ' +
    'for review, let the reviewer decide whether to apply their notes, then require final ' +
    'approval before the pull request is opened — which can also send the code back ' +
    'with a required note for a fix, up to three rounds. Every kind of human step ' +
    'appears in sequence, so it doubles as a tour of what a person can be asked to do.',
  entry: 'gatherContext',
  name: 'fully-supervised',
  nodes: mergeNodes(
    {
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
        group: 'gather context',
        onSubmit: 'storeContext',
        onTimeout: 'implement',
        storeAs: 'context.requirements',
        timeout: '15m',
        title: 'Provide implementation context',
        type: 'humanInput',
      },
      storeContext: {
        group: 'gather context',
        next: 'implement',
        title: 'Keep the answers',
        type: 'set',
        values: { 'context.requirements': { from: 'nodes.gatherContext.output.data' } },
      },
      implement: {
        group: 'implement',
        next: 'reviewDiff',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
      reviewDiff: {
        contentFrom: 'context.currentCodeResult.diff',
        description: 'Review the diff and leave notes. Submit when done.',
        group: 'human review',
        onSubmit: 'storeReviewNotes',
        onTimeout: 'finalApproval',
        storeAs: 'context.reviewNotes',
        timeout: '8h',
        title: 'Review the implementation diff',
        type: 'humanReview',
      },
      storeReviewNotes: {
        group: 'human review',
        next: 'applyNotesDecision',
        title: 'Keep the reviewer notes',
        type: 'set',
        values: { 'context.reviewNotes': { from: 'nodes.reviewDiff.output.feedback' } },
      },
      applyNotesDecision: {
        group: 'human review',
        onTimeout: 'finalApproval',
        options: [
          { label: 'Yes — apply notes and re-review', next: 'addressNotes', value: 'apply' },
          { label: 'No — looks good', next: 'finalApproval', value: 'skip' },
        ],
        timeout: '30m',
        title: 'Apply the review notes?',
        type: 'humanDecision',
      },
      addressNotes: {
        group: 'human review',
        inputs: {
          previousCodeResult: { from: 'context.currentCodeResult' },
          rejectionSummary: { from: 'context.reviewNotes' },
        },
        next: 'finalApproval',
        step: 'executeReviewFixImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Address the reviewer notes',
        type: 'step',
      },
      finalApproval: {
        description:
          'Approve to open a pull request that reviewers can see, request changes ' +
          '(with a note) to send the code back for a fix, or reject to stop the run.',
        group: 'approval',
        onApprove: 'openPR',
        onReject: 'terminateRejected',
        onRequestChanges: 'addressApprovalChanges',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'Final approval — open the PR?',
        type: 'humanApproval',
      },
      // The third change request ends the run: the fixer is entered twice at most.
      addressApprovalChanges: {
        group: 'approval',
        inputs: {
          previousCodeResult: { from: 'context.currentCodeResult' },
          rejectionSummary: { from: 'nodes.finalApproval.output.comment' },
        },
        maxVisits: 2,
        next: 'finalApproval',
        onExhausted: 'terminateRejected',
        step: 'executeReviewFixImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Fix the change the approver sent back',
        type: 'step',
      },
      terminateRejected: terminate('FAILED', { group: 'approval', title: 'Rejected' }),
      terminateTimedOut: terminate('TIMED_OUT', { group: 'approval', title: 'Approval timed out' }),
    },
    openPullRequest({ next: 'done' }),
    {
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
