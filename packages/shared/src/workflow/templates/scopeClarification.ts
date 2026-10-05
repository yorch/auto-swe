import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  initCounters,
  mergeNodes,
  prResult,
  reviewLoop,
  statusStamp,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * Collects human guidance before implementation starts.
 * Ideal for vague tickets where the agent needs direction before acting.
 */
export const SCOPE_CLARIFICATION_SPEC: WorkflowSpec = {
  description:
    'Ask a person for more context before the agent starts implementing. Useful for tickets ' +
    'that are vague or too high-level for the agent to act on without guidance.',
  entry: 'clarify',
  name: 'scope-clarification',
  nodes: mergeNodes(
    {
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
        group: 'clarify',
        onSubmit: 'storeClarification',
        onTimeout: 'validate',
        storeAs: 'context.clarification',
        timeout: '30m',
        title: 'Clarify implementation requirements',
        type: 'humanInput',
      },
      storeClarification: {
        group: 'clarify',
        next: 'validate',
        title: 'Keep the answers',
        type: 'set',
        values: { 'context.clarification': { from: 'nodes.clarify.output.data' } },
      },
    },
    // No status stamp here: the run starts at `clarify`, and this template's
    // validate node is entered from it.
    validatePhase({
      next: 'setImplementing',
      stamp: false,
      successCriteriaId: 'successCriteria',
    }),
    {
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
      implement: {
        group: 'implement',
        // Without this binding the human's answers never reach the implementer.
        inputs: { guidance: { default: '', from: 'context.clarification' } },
        next: 'initCounters',
        step: 'executeImplementation',
        title: 'Implement with the guidance',
        type: 'step',
      },
      initCounters: initCounters('setReviewing', { ci: false, group: 'implement' }),
    },
    reviewLoop({ approved: 'openPR', keepFixId: 'updateCodeAfterFix' }),
    {
      openPR: {
        group: 'finish',
        inputs: { codeResult: { from: 'context.currentCodeResult' } },
        next: 'done',
        step: 'createOrUpdatePullRequest',
        title: 'Open the pull request',
        type: 'step',
      },
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
