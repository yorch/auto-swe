import { describe, expect, it } from 'vitest';
import { parseWorkflowSpec } from '../spec.js';
import { DECOMPOSITION_EXAMPLE_SPEC } from './decomposition.spec.js';

describe('DECOMPOSITION_EXAMPLE_SPEC', () => {
  it('parses and validates', () => {
    expect(() => parseWorkflowSpec(DECOMPOSITION_EXAMPLE_SPEC)).not.toThrow();
  });

  it('uses planDecomposition + fanOut + mergeBranches', () => {
    const { nodes } = DECOMPOSITION_EXAMPLE_SPEC;
    const plan = nodes.plan;
    expect(plan?.type).toBe('step');
    if (plan?.type === 'step') expect(plan.step).toBe('planDecomposition');

    const fan = nodes.fanOutSubtasks;
    expect(fan?.type).toBe('fanOut');

    const merge = nodes.merge;
    expect(merge?.type).toBe('step');
    if (merge?.type === 'step') expect(merge.step).toBe('mergeBranches');
  });

  it('fanOut projects each branch result.branch so mergeBranches can bind a string[] directly', () => {
    const fan = DECOMPOSITION_EXAMPLE_SPEC.nodes.fanOutSubtasks;
    expect(fan?.type).toBe('fanOut');
    if (fan?.type === 'fanOut') {
      expect(fan.pluck).toBe('result.branch');
      expect(fan.itemKey).toBe('subtask');
    }
    const merge = DECOMPOSITION_EXAMPLE_SPEC.nodes.merge;
    if (merge?.type === 'step') {
      expect(merge.inputs?.sourceBranches).toEqual({
        from: 'nodes.fanOutSubtasks.output.plucked',
      });
    }
  });

  // Phase 3.5
  it('fanOut declares a concurrency cap so subagent runs are bounded', () => {
    const fan = DECOMPOSITION_EXAMPLE_SPEC.nodes.fanOutSubtasks;
    if (fan?.type === 'fanOut') {
      expect(typeof fan.concurrency).toBe('number');
      expect(fan.concurrency).toBeGreaterThan(0);
    }
  });

  it('wires resolveMergeConflict after a failed merge and binds its unmergedBranches tail', () => {
    const resolve = DECOMPOSITION_EXAMPLE_SPEC.nodes.resolveConflict;
    expect(resolve?.type).toBe('step');
    if (resolve?.type === 'step') {
      expect(resolve.step).toBe('resolveMergeConflict');
      expect(resolve.inputs?.sourceBranches).toEqual({
        from: 'nodes.merge.output.unmergedBranches',
      });
    }
    // The cond on merge.passed must route the failure path to the resolver.
    const checkMerge = DECOMPOSITION_EXAMPLE_SPEC.nodes.checkMerge;
    expect(checkMerge?.type).toBe('cond');
    if (checkMerge?.type === 'cond') {
      expect(checkMerge.onFalse).toBe('resolveConflict');
    }
  });
});
