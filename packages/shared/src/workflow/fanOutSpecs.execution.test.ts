import { describe, expect, it } from 'vitest';
import { DECOMPOSITION_EXAMPLE_SPEC } from './examples/decomposition.spec.js';
import { PER_BRANCH_GATES_EXAMPLE_SPEC } from './examples/perBranchGates.spec.js';
import type { Context } from './expr.js';
import { type Dispatcher, runSpec } from './interpreter.js';
import { parseWorkflowSpec, type WorkflowSpec } from './spec.js';
import { CONSENSUS_REVIEW_SPEC } from './templates/consensusReview.js';
import { PARALLEL_FAN_OUT_SPEC } from './templates/parallelFanOut.js';

/**
 * End-to-end execution of every shipped spec that reads a step's output from
 * INSIDE a fan-out branch (`nodes.<subgraphStep>.output` bound by a later
 * subgraph node). Each runs through `runSpec` with a scripted dispatcher and
 * must reach its success terminal — the shape-level spec tests next to each
 * template only prove the spec parses, not that its branch bindings resolve.
 */

type Inputs = Record<string, unknown>;
type StepScript = Record<string, unknown | ((inputs: Inputs, config: Inputs) => unknown)>;

function makeDispatcher(script: StepScript, signalQueue: Record<string, unknown[]> = {}) {
  const calls: Array<{ step: string; inputs: Record<string, unknown> }> = [];
  const dispatcher: Dispatcher = {
    async dispatchStep({ step, inputs, config }) {
      calls.push({ inputs, step });
      if (!(step in script)) {
        throw new Error(`no scripted output for step ${step}`);
      }
      const out = script[step];
      return typeof out === 'function'
        ? (out as (i: Inputs, c: Inputs) => unknown)(inputs, config)
        : out;
    },
    async recordStep() {},
    async waitSignal(name) {
      const q = signalQueue[name];
      return q && q.length > 0 ? q.shift() : undefined;
    },
  };
  return { calls, dispatcher };
}

const baseCtx = (): Context => ({
  context: {},
  nodes: {},
  request: { externalTicketId: 'TEST-1', repoId: 'repo-1' },
  workflow: { id: 'eng-test-1' },
});

const parsed = (spec: WorkflowSpec): WorkflowSpec => parseWorkflowSpec(spec);

const subtaskBranch = (inputs: Record<string, unknown>) => {
  const subtask = inputs.subtask as { id: string };
  return { branch: `auto/sub-${subtask.id}`, headSha: `sha-${subtask.id}` };
};

describe('CONSENSUS_REVIEW_SPEC executes', () => {
  const script = (
    reviews: Array<{ approved: boolean; rejectionSummary?: string }>
  ): StepScript => ({
    createOrUpdatePullRequest: { prNumber: 7, prUrl: 'https://example/pr/7' },
    executeImplementation: { branch: 'auto/TEST-1', headSha: 'sha-1' },
    executeReviewFixImplementation: { branch: 'auto/TEST-1', headSha: 'sha-2' },
    runReviewNetwork: () => reviews.shift() ?? { approved: true },
    updateDomainState: ({ status }: Inputs) => ({ status }),
    validateContext: { successCriteria: ['works'] },
  });

  it('both reviewers approve → PR opens → CI passes → SUCCESS', async () => {
    const { dispatcher, calls } = makeDispatcher(script([]), {
      ciPipelineSignal: [{ passed: true }],
    });
    const result = await runSpec(parsed(CONSENSUS_REVIEW_SPEC), baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result).toEqual({ prNumber: 7, prUrl: 'https://example/pr/7' });
    expect(calls.filter((c) => c.step === 'runReviewNetwork')).toHaveLength(2);
    expect(calls.some((c) => c.step === 'executeReviewFixImplementation')).toBe(false);
  });

  it('one rejection routes through the fix loop, exporting the branch rejection summary', async () => {
    const reviews = [
      { approved: true },
      { approved: false, rejectionSummary: 'needs tests' },
      { approved: true },
      { approved: true },
    ];
    const { dispatcher, calls } = makeDispatcher(script(reviews), {
      ciPipelineSignal: [{ passed: true }],
    });
    const result = await runSpec(parsed(CONSENSUS_REVIEW_SPEC), baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    const fix = calls.find((c) => c.step === 'executeReviewFixImplementation');
    expect(fix).toBeDefined();
    // The rejecting branch's `context.branchRejectionSummary` export (bound
    // from `nodes.runBranchReview.output.rejectionSummary`) reached the join.
    const firstRound = (
      (fix?.inputs.rejectionSummary as Array<{ exports?: Record<string, unknown> }>) ?? []
    ).map((r) => r.exports?.['context.branchRejectionSummary']);
    expect(firstRound).toEqual([undefined, 'needs tests']);
    expect(calls.filter((c) => c.step === 'runReviewNetwork')).toHaveLength(4);
  });
});

describe('PARALLEL_FAN_OUT_SPEC executes', () => {
  // Scripted like the worker: each subtask's implementer pushes its own
  // `<prefix>/<ticket>/<subtask.id>` branch.
  const implement = (inputs: Inputs) => {
    const subtask = inputs.subtask as { id: string };
    return { branch: `auto/TEST-1/${subtask.id}`, headSha: `sha-${subtask.id}` };
  };
  const script = (merge: unknown, resolve?: unknown): StepScript => ({
    createOrUpdatePullRequest: { prNumber: 3, prUrl: 'https://example/pr/3' },
    executeImplementation: implement,
    mergeBranches: merge,
    ...(resolve ? { resolveMergeConflict: resolve } : {}),
    updateDomainState: ({ status }: Inputs) => ({ status }),
    validateContext: { successCriteria: [] },
  });
  const inputsOf = (calls: Array<{ step: string; inputs: Inputs }>, step: string) =>
    calls.find((c) => c.step === step)?.inputs;

  it('implements each subtask on its own branch, merges them, and opens ONE PR for the merge', async () => {
    const { dispatcher, calls } = makeDispatcher(
      script({
        headSha: 'sha-merged',
        mergedBranches: [],
        passed: true,
        unmergedBranches: [],
      })
    );
    const result = await runSpec(parsed(PARALLEL_FAN_OUT_SPEC), baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result).toEqual({ prNumber: 3, prUrl: 'https://example/pr/3' });

    // Every implementer received a real Subtask (the worker names the branch
    // from `subtask.id`).
    const subtasks = calls
      .filter((c) => c.step === 'executeImplementation')
      .map((c) => c.inputs.subtask as { id: string; title: string; description: string });
    expect(subtasks.map((t) => t.id)).toEqual(['feature', 'tests', 'docs']);
    expect(subtasks.every((t) => t.title && t.description)).toBe(true);

    // The merge integrates exactly the pushed branches into a branch that is
    // not a git-ref parent of them.
    expect(inputsOf(calls, 'mergeBranches')).toEqual({
      sourceBranches: ['auto/TEST-1/feature', 'auto/TEST-1/tests', 'auto/TEST-1/docs'],
      targetBranch: 'eng-test-1',
    });

    // The PR step is bound to a CodeResult for the integrated branch — the
    // step would throw on an unbound `context.currentCodeResult`.
    const codeResult = inputsOf(calls, 'createOrUpdatePullRequest')?.codeResult as Record<
      string,
      unknown
    >;
    expect(codeResult).toMatchObject({
      branch: 'eng-test-1',
      filesChanged: [],
      headSha: 'sha-merged',
      repoId: 'repo-1',
      testResults: { passed: true },
    });
  });

  it('routes a merge conflict through the resolver with every branch, then opens the PR', async () => {
    const { dispatcher, calls } = makeDispatcher(
      script(
        {
          conflicts: [{ branch: 'auto/TEST-1/docs', output: 'CONFLICT' }],
          mergedBranches: ['auto/TEST-1/feature', 'auto/TEST-1/tests'],
          passed: false,
          unmergedBranches: ['auto/TEST-1/docs'],
        },
        { headSha: 'sha-resolved', passed: true }
      )
    );
    const result = await runSpec(parsed(PARALLEL_FAN_OUT_SPEC), baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(inputsOf(calls, 'resolveMergeConflict')).toEqual({
      sourceBranches: ['auto/TEST-1/feature', 'auto/TEST-1/tests', 'auto/TEST-1/docs'],
      targetBranch: 'eng-test-1',
    });
    const pr = inputsOf(calls, 'createOrUpdatePullRequest');
    expect((pr?.codeResult as { headSha?: string } | undefined)?.headSha).toBe('sha-resolved');
  });

  it('fails without opening a PR when the conflict cannot be resolved', async () => {
    const { dispatcher, calls } = makeDispatcher(
      script(
        { conflicts: [], mergedBranches: [], passed: false, unmergedBranches: [] },
        { conflicts: [{ branch: 'x', output: 'still' }], passed: false }
      )
    );
    const result = await runSpec(parsed(PARALLEL_FAN_OUT_SPEC), baseCtx(), dispatcher);
    expect(result.status).toBe('FAILED');
    expect(calls.some((c) => c.step === 'createOrUpdatePullRequest')).toBe(false);
  });

  it('fails without merging when a branch failed', async () => {
    let n = 0;
    const { dispatcher, calls } = makeDispatcher({
      ...script({ passed: true }),
      executeImplementation: (inputs: Inputs) => {
        n++;
        if (n === 2) {
          throw new Error('implementer blew up');
        }
        return implement(inputs);
      },
    });
    const result = await runSpec(parsed(PARALLEL_FAN_OUT_SPEC), baseCtx(), dispatcher);
    expect(result.status).toBe('FAILED');
    expect(calls.some((c) => c.step === 'mergeBranches')).toBe(false);
  });
});

describe('DECOMPOSITION_EXAMPLE_SPEC executes', () => {
  it('plans → fans out → merges the plucked branch names → reviews → SUCCESS', async () => {
    const { dispatcher } = makeDispatcher({
      executeImplementation: subtaskBranch,
      mergeBranches: ({ sourceBranches }: Inputs) => ({
        mergedBranches: sourceBranches,
        passed: true,
        unmergedBranches: [],
      }),
      planDecomposition: { subtasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      runReviewNetwork: { approved: true },
    });
    const result = await runSpec(parsed(DECOMPOSITION_EXAMPLE_SPEC), baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    // `pluck: 'result.branch'` reads each branch's terminate result, which is
    // bound from `context.currentCodeResult` ← `nodes.subImpl.output`.
    expect(result.result).toEqual({
      mergedBranches: ['auto/sub-a', 'auto/sub-b', 'auto/sub-c'],
      targetBranch: 'auto/feature',
    });
  });
});

describe('PER_BRANCH_GATES_EXAMPLE_SPEC executes', () => {
  it('runs lint/typecheck/tests inside every branch before merging → SUCCESS', async () => {
    const { dispatcher, calls } = makeDispatcher({
      executeImplementation: subtaskBranch,
      mergeBranches: ({ sourceBranches }: Inputs) => ({
        mergedBranches: sourceBranches,
        passed: true,
      }),
      planDecomposition: { subtasks: [{ id: 'a' }, { id: 'b' }] },
      runLint: { passed: true },
      runTests: { passed: true },
      runTypecheck: { passed: true },
    });
    const result = await runSpec(parsed(PER_BRANCH_GATES_EXAMPLE_SPEC), baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result).toEqual({
      mergedBranches: ['auto/sub-a', 'auto/sub-b'],
      targetBranch: 'auto/feature',
    });
    for (const gate of ['runLint', 'runTypecheck', 'runTests']) {
      expect(calls.filter((c) => c.step === gate)).toHaveLength(2);
    }
  });
});
