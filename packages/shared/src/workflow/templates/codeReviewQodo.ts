import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { CODE_REVIEW_SPEC } from './codeReview.js';

export const CODE_REVIEW_QODO_SPEC: WorkflowSpec = {
  ...CODE_REVIEW_SPEC,
  description:
    'Review a finished run change with the reviewer network and, for pull requests, read Qodo findings on the same head before publishing the combined result.',
  name: 'code-review-qodo',
  nodes: {
    ...CODE_REVIEW_SPEC.nodes,
    review: { ...CODE_REVIEW_SPEC.nodes.review, next: 'isPr' } as WorkflowSpec['nodes'][string],
    isPr: {
      expr: 'request.payload.reviewOf.mode == "pr"',
      group: 'review',
      onFalse: 'publish',
      onTrue: 'qodo',
      type: 'cond',
    },
    qodo: {
      group: 'review',
      inputs: {
        headSha: { from: 'nodes.load.output.headSha' },
        prUrl: { from: 'nodes.load.output.prUrl' },
      },
      next: 'publishQodo',
      step: 'awaitQodoReview',
      title: 'Read Qodo findings',
      type: 'step',
    },
    publishQodo: {
      group: 'review',
      inputs: { qodo: { from: 'nodes.qodo.output' }, review: { from: 'nodes.review.output' } },
      next: 'doneQodo',
      step: 'publishReviewResult',
      title: 'Publish the combined review',
      type: 'step',
    },
    doneQodo: {
      result: { review: { from: 'nodes.publishQodo.output' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
