import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  mergeNodes,
  openPullRequest,
  prResult,
  statusStamp,
  storeCodeResult,
  terminate,
} from './authoring/index.js';

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
        onTimeout: 'setImplementing',
        storeAs: 'context.requirements',
        timeout: '15m',
        title: 'Provide implementation context',
        type: 'humanInput',
      },
      storeContext: {
        group: 'gather context',
        next: 'setImplementing',
        title: 'Keep the answers',
        type: 'set',
        values: { 'context.requirements': { from: 'nodes.gatherContext.output.data' } },
      },
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
      implement: {
        group: 'implement',
        next: 'storeCodeResult',
        step: 'executeImplementation',
        title: 'Implement the ticket',
        type: 'step',
      },
      storeCodeResult: storeCodeResult('reviewDiff', { group: 'implement' }),
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
        next: 'updateCodeAfterNotes',
        step: 'executeReviewFixImplementation',
        title: 'Address the reviewer notes',
        type: 'step',
      },
      updateCodeAfterNotes: {
        group: 'human review',
        next: 'finalApproval',
        title: 'Keep the revised code',
        type: 'set',
        values: { 'context.currentCodeResult': { from: 'nodes.addressNotes.output' } },
      },
      finalApproval: {
        description: 'This will open a pull request that reviewers can see.',
        group: 'approval',
        onApprove: 'openPR',
        onReject: 'terminateRejected',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'Final approval — open the PR?',
        type: 'humanApproval',
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
