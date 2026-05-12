/**
 * Example spec — decompose a work request, run a parallel implementer per
 * subtask, merge the resulting branches into the parent feature branch, then
 * fall through to a single review pass.
 *
 * The fan-out subgraph is intentionally narrow (just the implementer) so the
 * example stays readable. Real teams will want per-branch review + gates;
 * see the phase-3 follow-ups in docs/configurable-workflows.md.
 *
 * Spec shape:
 *
 *   plan → fanOut(over: $.subtasks)              ─┐
 *                                                 ├─ per subtask:
 *                                                 │     subImpl
 *                                                 │     subDone (terminate SUCCESS, branch in result)
 *                                                ─┘
 *   → merge (sourceBranches = fan.output.plucked) → review → done
 */

import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

export const DECOMPOSITION_EXAMPLE_SPEC: WorkflowSpec = {
  description:
    'Example workflow: decompose work request → fan-out implementer per subtask → merge subtask branches into the feature branch → review.',
  entry: 'plan',
  name: 'engineering-with-decomposition',
  nodes: {
    checkApproval: {
      expr: 'nodes.review.output.approved == true',
      onFalse: 'terminateRejected',
      onTrue: 'done',
      type: 'cond',
    },
    done: {
      result: {
        mergedBranches: { from: 'nodes.merge.output.mergedBranches' },
        targetBranch: { from: 'context.featureBranch' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    fanOutSubtasks: {
      itemKey: 'subtask',
      join: 'merge',
      onBranchFail: 'block',
      over: { from: 'nodes.plan.output.subtasks' },
      // Project each branch's terminate result (a `{ branch }` object) into
      // a flat string[] consumable by mergeBranches.inputs.sourceBranches.
      pluck: 'result.branch',
      subgraph: 'subImpl',
      type: 'fanOut',
    },
    merge: {
      inputs: {
        sourceBranches: { from: 'nodes.fanOutSubtasks.output.plucked' },
        targetBranch: { from: 'context.featureBranch' },
      },
      next: 'review',
      step: 'mergeBranches',
      type: 'step',
    },
    plan: {
      next: 'recordFeatureBranch',
      step: 'planDecomposition',
      type: 'step',
    },
    recordFeatureBranch: {
      next: 'fanOutSubtasks',
      type: 'set',
      values: {
        'context.featureBranch': { literal: 'auto/feature' },
      },
    },
    review: {
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
      },
      next: 'checkApproval',
      step: 'runReviewNetwork',
      type: 'step',
    },
    subDone: {
      result: {
        branch: { from: 'context.currentCodeResult.branch' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    subImpl: {
      inputs: {
        subtask: { from: 'subtask' },
      },
      next: 'subRecord',
      step: 'executeImplementation',
      type: 'step',
    },
    subRecord: {
      next: 'subDone',
      type: 'set',
      values: {
        'context.currentCodeResult': { from: 'nodes.subImpl.output' },
      },
    },
    terminateRejected: {
      result: { rejection: { from: 'nodes.review.output.rejectionSummary' } },
      status: 'FAILED',
      type: 'terminate',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
