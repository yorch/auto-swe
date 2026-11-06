import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

export const CODE_REVIEW_SPEC: WorkflowSpec = {
  description:
    'Review a finished run change with security, domain and performance reviewers, and publish findings without modifying the change.',
  entry: 'load',
  name: 'code-review',
  nodes: {
    load: {
      group: 'review',
      next: 'review',
      step: 'loadChangeForReview',
      title: 'Load the source change',
      type: 'step',
    },
    review: {
      group: 'review',
      inputs: {
        codeResult: { from: 'nodes.load.output' },
        systemPrompt: { default: '', from: 'request.payload.systemPrompt' },
      },
      next: 'publish',
      step: 'runReviewNetwork',
      title: 'Review the change',
      type: 'step',
    },
    publish: {
      group: 'review',
      inputs: { review: { from: 'nodes.review.output' } },
      next: 'done',
      step: 'publishReviewResult',
      title: 'Publish the review',
      type: 'step',
    },
    done: {
      result: { review: { from: 'nodes.publish.output' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
