import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { prResult, qualityGate, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

/**
 * Show the diff to a human reviewer; optionally apply their feedback before PR.
 */
export const HUMAN_CODE_REVIEW_SPEC: WorkflowSpec = {
  description:
    'Implement, run lint and type checks, then show the diff to a human reviewer before the ' +
    'pull request is opened. The reviewer can leave notes for the agent to address, or ' +
    'approve the diff as it is.',
  entry: 'validate',
  name: 'human-code-review',
  ...authored(
    macro('validate', 'validatePhase@1', { next: 'implement', successCriteria: false }),
    {
      implement: {
        group: 'implement',
        next: 'runLint',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
      runLint: qualityGate('runLint', 'runTypecheck', { group: 'implement' }),
      runTypecheck: qualityGate('runTypecheck', 'humanReview', { group: 'implement' }),
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
        next: 'openPR',
        step: 'executeReviewFixImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Address the reviewer notes',
        type: 'step',
      },
    },
    macro('pr', 'openPullRequest@1', { next: 'done' }),
    {
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
