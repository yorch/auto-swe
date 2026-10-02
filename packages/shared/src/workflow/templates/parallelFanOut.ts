import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  mergeNodes,
  openPullRequest,
  prResult,
  statusStamp,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * Splits the ticket into parallel sub-task branches using fanOut, integrates
 * them, and opens one PR.
 *
 *   validate → fanOut(3 subtasks, concurrency 3)
 *                └─ per subtask: executeImplementation → record → terminate
 *                   (result.branch = that subtask's pushed branch)
 *            → all succeeded? → mergeBranches(plucked branches → integration branch)
 *                                 ↓ conflict → resolveMergeConflict(all branches)
 *            → build ONE CodeResult for the integration branch → open the PR
 *
 * Each branch pushes `<prefix>/<ticket>/<subtask.id>`. The integration branch
 * is the run's workflow id rather than `<prefix>/<ticket>`: git cannot hold a
 * ref and a ref nested under it, so `auto/T` could not coexist with the
 * `auto/T/feature` sub-branches. The PR's CodeResult is built explicitly from
 * the merge output — the branch contexts are gone after the join, so nothing
 * at the top level holds a `context.currentCodeResult` to open a PR from.
 *
 * Demonstrates: fanOut concurrency, per-branch context, pluck, merge + conflict
 * resolution, onBranchFail.
 */
export const PARALLEL_FAN_OUT_SPEC: WorkflowSpec = {
  description:
    'Validate context, split the work into three parallel branches ' +
    '(feature implementation, tests, documentation), merge them into one ' +
    'integration branch (resolving conflicts with the merge-conflict agent if ' +
    'needed), then open a single PR. Each branch runs an isolated ' +
    'executeImplementation agent. Demonstrates the fanOut node with ' +
    'concurrency=3, pluck, and merge.',
  entry: 'setValidating',
  name: 'parallel-fan-out',
  nodes: mergeNodes(
    validatePhase({ next: 'setImplementing' }),
    {
      setImplementing: statusStamp('IMPLEMENTING', 'buildSubtasks', { group: 'implement' }),
      branchDone: {
        group: 'fan-out',
        title: 'Branch done',
        result: { branch: { from: 'context.currentCodeResult.branch' } },
        status: 'SUCCESS',
        type: 'terminate',
      },
      buildIntegratedResult: {
        group: 'merge',
        title: 'Describe the integrated change',
        next: 'openPR',
        type: 'set',
        values: {
          // Keys apply in order: the literal skeleton first, then the fields
          // that come from this run.
          'context.currentCodeResult': {
            literal: {
              diff: '',
              filesChanged: [],
              implementationNotes:
                'Integrated from three parallel branches (feature, tests, docs). ' +
                'Each branch ran its own tests in isolation; CI on this pull request ' +
                'is the verdict for the combined change.',
              testResults: {
                duration_ms: 0,
                failing: 0,
                passed: true,
                passing: 0,
                stdout: '',
                total: 0,
              },
            },
          },
          'context.currentCodeResult.branch': { from: 'context.integrationBranch' },
          'context.currentCodeResult.headSha': {
            expr: 'nodes.resolveConflict.output.headSha ?? nodes.merge.output.headSha',
          },
          'context.currentCodeResult.repoId': { from: 'request.repoId' },
        },
      },
      buildSubtasks: {
        group: 'implement',
        title: 'Split into subtasks',
        next: 'fanOutImpl',
        type: 'set',
        values: {
          // `id` names each branch (`<prefix>/<ticket>/<id>`); title and
          // description are what the implementer is asked to do.
          'context.subtasks': {
            literal: [
              {
                description: 'Implement the core feature logic',
                id: 'feature',
                title: 'Feature implementation',
              },
              {
                description: 'Write unit and integration tests for the feature',
                id: 'tests',
                title: 'Tests',
              },
              {
                description: 'Update inline docs and changelog for the feature',
                id: 'docs',
                title: 'Documentation',
              },
            ],
          },
        },
      },
      checkFanOutResult: {
        group: 'fan-out',
        title: 'All branches succeeded?',
        expr: 'nodes.fanOutImpl.output.failed == 0',
        onFalse: 'terminatePartialFail',
        onTrue: 'recordIntegrationBranch',
        type: 'cond',
      },
      checkMerge: {
        group: 'merge',
        title: 'Merged cleanly?',
        expr: 'nodes.merge.output.passed == true',
        onFalse: 'resolveConflict',
        onTrue: 'buildIntegratedResult',
        type: 'cond',
      },
      checkResolved: {
        group: 'merge',
        title: 'Conflicts resolved?',
        expr: 'nodes.resolveConflict.output.passed == true',
        onFalse: 'terminateMergeFailed',
        onTrue: 'buildIntegratedResult',
        type: 'cond',
      },
      fanOutImpl: {
        group: 'fan-out',
        title: 'Implement each subtask in parallel',
        concurrency: 3,
        exports: ['context.currentCodeResult'],
        itemKey: 'subtask',
        join: 'storeResults',
        onBranchFail: 'continue',
        over: { from: 'context.subtasks' },
        // Each branch's terminate result carries its pushed branch name.
        pluck: 'result.branch',
        subgraph: 'implementBranch',
        type: 'fanOut',
      },
      implementBranch: {
        group: 'fan-out',
        title: 'Implement one subtask',
        inputs: { subtask: { from: 'subtask' } },
        next: 'recordBranchResult',
        step: 'executeImplementation',
        type: 'step',
      },
      merge: {
        group: 'merge',
        title: 'Merge the branches',
        inputs: {
          sourceBranches: { from: 'nodes.fanOutImpl.output.plucked' },
          targetBranch: { from: 'context.integrationBranch' },
        },
        next: 'checkMerge',
        onFail: 'warn',
        step: 'mergeBranches',
        type: 'step',
      },
      // Stash the branch's implementer output: the fanOut `exports` list reads
      // it at join time, and `branchDone` reports its branch for the pluck.
      recordBranchResult: {
        group: 'fan-out',
        title: 'Keep the branch result',
        next: 'branchDone',
        type: 'set',
        values: { 'context.currentCodeResult': { from: 'nodes.implementBranch.output' } },
      },
      recordIntegrationBranch: {
        group: 'merge',
        title: 'Name the integration branch',
        next: 'merge',
        type: 'set',
        values: { 'context.integrationBranch': { from: 'workflow.id' } },
      },
      resolveConflict: {
        group: 'merge',
        title: 'Resolve merge conflicts',
        inputs: {
          // Every branch, not just the unmerged tail: `mergeBranches` pushes
          // nothing when it hits a conflict, so the branches it merged before
          // the conflict are not on the integration branch yet.
          sourceBranches: { from: 'nodes.fanOutImpl.output.plucked' },
          targetBranch: { from: 'context.integrationBranch' },
        },
        next: 'checkResolved',
        onFail: 'warn',
        step: 'resolveMergeConflict',
        type: 'step',
      },
      storeResults: {
        group: 'fan-out',
        title: 'Keep the branch results',
        next: 'checkFanOutResult',
        type: 'set',
        values: { 'context.fanOutResults': { from: 'nodes.fanOutImpl.output' } },
      },
      terminateMergeFailed: {
        group: 'merge',
        title: 'Merge failed',
        result: { conflicts: { from: 'nodes.resolveConflict.output.conflicts' } },
        status: 'FAILED',
        type: 'terminate',
      },
      terminatePartialFail: {
        group: 'fan-out',
        title: 'A branch failed',
        status: 'FAILED',
        type: 'terminate',
      },
    },
    openPullRequest({ next: 'done' }),
    {
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
