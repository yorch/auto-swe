/**
 * Example spec — decompose a work request, run implementers in parallel per
 * subtask (concurrency-bounded), merge the resulting branches into the parent
 * feature branch, fall back to the conflict-resolver agent if any branch
 * conflicts, then run a single review pass.
 *
 * The fan-out subgraph is intentionally narrow (just the implementer) so the
 * example stays readable. Real teams will want per-branch review + gates.
 *
 * Spec shape:
 *
 *   plan → fanOut(over: $.subtasks, concurrency: 3)   ─┐
 *                                                       ├─ per subtask:
 *                                                       │     subImpl
 *                                                       │     subDone (terminate SUCCESS, branch in result)
 *                                                      ─┘
 *   → merge (sourceBranches = fan.output.plucked)
 *     ↓ if merge.passed → review
 *     ↓ if !merge.passed → resolveConflict
 *                          ↓ if passed → review
 *                          ↓ if !passed → terminateMergeFailed
 *
 * `resolveConflict` consumes `nodes.merge.output.unmergedBranches` (the tail
 * starting at the conflict) so the resolver only retries the branches that
 * actually need help, not the ones that already merged cleanly.
 */

import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

export const DECOMPOSITION_EXAMPLE_SPEC: WorkflowSpec = {
  description:
    'Example workflow: decompose → parallel fan-out implementer per subtask → merge → resolve conflicts if needed → review.',
  entry: 'plan',
  name: 'engineering-with-decomposition',
  nodes: {
    checkApproval: {
      expr: 'nodes.review.output.approved == true',
      onFalse: 'terminateRejected',
      onTrue: 'done',
      type: 'cond',
    },
    checkMerge: {
      expr: 'nodes.merge.output.passed == true',
      onFalse: 'resolveConflict',
      onTrue: 'review',
      type: 'cond',
    },
    checkResolved: {
      expr: 'nodes.resolveConflict.output.passed == true',
      onFalse: 'terminateMergeFailed',
      onTrue: 'review',
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
      concurrency: 3,
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
      next: 'checkMerge',
      onFail: 'warn',
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
    resolveConflict: {
      inputs: {
        // mergeBranches surfaces the conflicted tail at `output.unmergedBranches`
        // so the resolver only retries branches that actually need help.
        sourceBranches: { from: 'nodes.merge.output.unmergedBranches' },
        targetBranch: { from: 'context.featureBranch' },
      },
      next: 'checkResolved',
      onFail: 'warn',
      step: 'resolveMergeConflict',
      type: 'step',
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
    terminateMergeFailed: {
      result: {
        conflicts: { from: 'nodes.resolveConflict.output.conflicts' },
      },
      status: 'FAILED',
      type: 'terminate',
    },
    terminateRejected: {
      result: { rejection: { from: 'nodes.review.output.rejectionSummary' } },
      status: 'FAILED',
      type: 'terminate',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
