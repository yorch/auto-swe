/**
 * Example spec — decompose a work request, run a parallel implementer per
 * subtask, merge the resulting branches into the parent feature branch, then
 * fall through to the standard review/CI loop.
 *
 * The fan-out subgraph for each subtask is intentionally narrow (just the
 * implementer) so the example stays readable. Real teams will want a per-
 * branch review + gate sub-pipeline; see the open question in phase 3.
 *
 * Spec shape:
 *
 *   plan → fanOut(over: subtasks) ┐
 *                                 ├─ for each subtask:
 *                                 │     subImpl
 *                                 │     subDone (terminate SUCCESS, branch exported)
 *                                 └─ join → merge → review → CI → done
 */

import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

export const DECOMPOSITION_EXAMPLE_SPEC: WorkflowSpec = {
  description:
    'Example workflow: decompose work request → fan-out implementer per subtask → merge subtask branches into the feature branch → review + CI.',
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
      exports: ['context.currentCodeResult'],
      itemKey: 'subtask',
      join: 'merge',
      onBranchFail: 'block',
      over: { from: 'nodes.plan.output.subtasks' },
      subgraph: 'subImpl',
      type: 'fanOut',
    },
    merge: {
      inputs: {
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
        // Mirrors executeImplementation's default branch naming so
        // `mergeBranches` can default-derive the target.
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
        // Branch is what mergeBranches needs to fast-forward into the
        // feature branch; recordExports lifts it via the fanOut exports.
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
