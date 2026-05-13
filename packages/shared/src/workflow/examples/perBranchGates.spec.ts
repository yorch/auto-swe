/**
 * Phase-8 example: decompose → fan-out implementer per subtask, run lint +
 * typecheck + tests **inside each branch** before allowing the branch to
 * publish its commit ref, then merge.
 *
 * Differs from `decomposition.spec.ts` in one key way: the fan-out subgraph
 * goes `subImpl → subRecord → subLint → subTypecheck → subTests → subDone`
 * instead of just `subImpl → subDone`. A failing gate inside a branch
 * terminates that branch FAILED (because the gate's `onFail` is `'block'`),
 * which the parent picks up via `onBranchFail: 'block'`. The blocking
 * semantics mean the run dies fast at the first bad branch instead of
 * merging green ones with red siblings.
 *
 * Real teams will want `onBranchFail: 'continue'` + a downstream cond that
 * counts the failed entries before deciding whether to merge — that pattern
 * is left to the team's spec because the right threshold is project-specific
 * (e.g. "merge if ≥75% of branches passed" vs "merge if all").
 *
 * Note: this example terminates after `merge` rather than chaining
 * `runReviewNetwork`, because the review step's dispatcher requires a
 * `CodeResult` input that the merge step doesn't produce. Teams that want
 * post-merge review should add an adapter `set` node that builds a CodeResult
 * (typically `{ branch: context.featureBranch, headSha: nodes.merge.output.headSha, ... }`)
 * before binding `runReviewNetwork.inputs.codeResult` to it.
 */

import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

export const PER_BRANCH_GATES_EXAMPLE_SPEC: WorkflowSpec = {
  description:
    'Example workflow: decompose → fan-out implementer + per-branch lint/typecheck/tests → merge.',
  entry: 'plan',
  name: 'engineering-with-per-branch-gates',
  nodes: {
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
      pluck: 'result.branch',
      subgraph: 'subImpl',
      type: 'fanOut',
    },
    merge: {
      inputs: {
        sourceBranches: { from: 'nodes.fanOutSubtasks.output.plucked' },
        targetBranch: { from: 'context.featureBranch' },
      },
      next: 'done',
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
      values: { 'context.featureBranch': { literal: 'auto/feature' } },
    },
    subDone: {
      // `branch` is what the parent's `pluck: 'result.branch'` projects into
      // `output.plucked` — the merge step uses this directly.
      result: { branch: { from: 'context.currentCodeResult.branch' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
    // ── Per-branch subgraph ────────────────────────────────────────────────
    subImpl: {
      inputs: { subtask: { from: 'subtask' } },
      next: 'subRecord',
      step: 'executeImplementation',
      type: 'step',
    },
    subLint: {
      next: 'subTypecheck',
      onFail: 'block',
      step: 'runLint',
      type: 'step',
    },
    subRecord: {
      // Mirrors the decomposition example: stash the implementer output so
      // both the gates AND subDone can read the resulting branch name from
      // context. Each gate runs against the same per-branch workspace the
      // implementer just wrote into.
      next: 'subLint',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.subImpl.output' } },
    },
    subTests: {
      next: 'subDone',
      onFail: 'block',
      step: 'runTests',
      type: 'step',
    },
    subTypecheck: {
      next: 'subTests',
      onFail: 'block',
      step: 'runTypecheck',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
