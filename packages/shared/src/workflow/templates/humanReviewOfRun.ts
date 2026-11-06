import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

export const HUMAN_REVIEW_OF_RUN_SPEC: WorkflowSpec = {
  description:
    'Show a finished run diff to a human reviewer, collect their note and decision, and publish the review without changing the code.',
  entry: 'load',
  name: 'human-review-of-run',
  nodes: {
    load: {
      group: 'review',
      next: 'note',
      step: 'loadChangeForReview',
      title: 'Load the source change',
      type: 'step',
    },
    note: {
      contentFrom: 'nodes.load.output.diff',
      description: 'Inspect the source diff and leave a review note.',
      group: 'review',
      onSubmit: 'decision',
      onTimeout: 'timedOut',
      timeout: '24h',
      title: 'Review the source change',
      type: 'humanReview',
    },
    decision: {
      group: 'review',
      onTimeout: 'timedOut',
      options: [
        { label: 'Approve', next: 'approve', value: 'approve' },
        { label: 'Request changes', next: 'reject', value: 'request-changes' },
      ],
      timeout: '24h',
      title: 'Approve this change?',
      type: 'humanDecision',
    },
    approve: {
      group: 'review',
      next: 'publish',
      type: 'set',
      values: {
        'context.humanReview.decision': { literal: 'approve' },
        'context.humanReview.feedback': { from: 'nodes.note.output.feedback', default: '' },
      },
    },
    reject: {
      group: 'review',
      next: 'publish',
      type: 'set',
      values: {
        'context.humanReview.decision': { literal: 'request-changes' },
        'context.humanReview.feedback': { from: 'nodes.note.output.feedback', default: '' },
      },
    },
    publish: {
      group: 'review',
      inputs: { human: { from: 'context.humanReview' } },
      next: 'done',
      step: 'publishReviewResult',
      title: 'Publish the human review',
      type: 'step',
    },
    done: {
      result: { review: { from: 'nodes.publish.output' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
    timedOut: { status: 'TIMED_OUT', type: 'terminate' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
