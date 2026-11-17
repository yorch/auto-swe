/**
 * Spec builders shared by the skeleton policy tests: a minimal compliant delivering plan and a
 * minimal compliant output-only plan, as raw objects a test can mutate before parsing.
 */

import { parseWorkflowSpec, SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

export type RawSpec = {
  entry: string;
  name: string;
  description: string;
  schemaVersion: typeof SPEC_SCHEMA_VERSION;
  nodes: Record<string, Record<string, unknown>>;
};

/** implement -> review -> approval cond -> openPR -> merge wait -> done. */
export function deliveringRaw(): RawSpec {
  return {
    description: 'fixture',
    entry: 'implement',
    name: 'fixture-delivering',
    nodes: {
      checkApproval: {
        expr: 'nodes.review.output.approved == true',
        onFalse: 'terminateReviewFailed',
        onTrue: 'openPR',
        type: 'cond',
      },
      done: { status: 'SUCCESS', type: 'terminate' },
      implement: {
        next: 'review',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        type: 'step',
      },
      openPR: {
        inputs: { codeResult: { from: 'context.currentCodeResult' } },
        next: 'waitForHumanMerge',
        step: 'createOrUpdatePullRequest',
        type: 'step',
      },
      review: { next: 'checkApproval', step: 'runReviewNetwork', type: 'step' },
      terminateMergeTimedOut: { status: 'TIMED_OUT', type: 'terminate' },
      terminateReviewFailed: { status: 'FAILED', type: 'terminate' },
      waitForHumanMerge: {
        name: 'humanMergeSignal',
        onReceive: 'done',
        onTimeout: 'terminateMergeTimedOut',
        timeout: '7d',
        type: 'signal',
      },
    },
    schemaVersion: SPEC_SCHEMA_VERSION,
  };
}

/** The delivering plan with a quality gate between the review and the pull request. */
export function deliveringWithGatesRaw(): RawSpec {
  const raw = deliveringRaw();
  raw.nodes.checkApproval = { ...raw.nodes.checkApproval, onTrue: 'gates' };
  raw.nodes.gates = {
    config: { gates: ['lint', 'typecheck', 'test'] },
    next: 'openPR',
    step: 'runQualityGates',
    type: 'step',
  };
  return raw;
}

/** agent -> human review -> done. */
export function outputOnlyRaw(): RawSpec {
  return {
    description: 'fixture',
    entry: 'draft',
    name: 'fixture-output-only',
    nodes: {
      done: { status: 'SUCCESS', type: 'terminate' },
      draft: { agentRef: 'contentWriter', next: 'reviewDraft', type: 'agent' },
      reviewDraft: {
        contentFrom: 'nodes.draft.output',
        onSubmit: 'done',
        onTimeout: 'timedOut',
        timeout: '7d',
        title: 'Review the draft',
        type: 'humanReview',
      },
      timedOut: { status: 'TIMED_OUT', type: 'terminate' },
    },
    schemaVersion: SPEC_SCHEMA_VERSION,
  };
}

export function parse(raw: RawSpec): WorkflowSpec {
  return parseWorkflowSpec(raw);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
