import { describe, expect, it } from 'vitest';
import { parseWorkflowSpec } from '../spec.js';
import { PER_BRANCH_GATES_EXAMPLE_SPEC } from './perBranchGates.spec.js';

describe('PER_BRANCH_GATES_EXAMPLE_SPEC', () => {
  it('parses and validates', () => {
    expect(() => parseWorkflowSpec(PER_BRANCH_GATES_EXAMPLE_SPEC)).not.toThrow();
  });

  it('every per-branch gate node is blocking', () => {
    const gateIds = ['subLint', 'subTypecheck', 'subTests'] as const;
    for (const id of gateIds) {
      const node = PER_BRANCH_GATES_EXAMPLE_SPEC.nodes[id];
      expect(node?.type).toBe('step');
      if (node?.type === 'step') {
        expect(node.onFail).toBe('block');
      }
    }
  });

  it('subDone projects branch from currentCodeResult so mergeBranches can pluck it', () => {
    const subDone = PER_BRANCH_GATES_EXAMPLE_SPEC.nodes.subDone;
    expect(subDone?.type).toBe('terminate');
    if (subDone?.type === 'terminate') {
      expect(subDone.result?.branch).toEqual({ from: 'context.currentCodeResult.branch' });
    }
    const fan = PER_BRANCH_GATES_EXAMPLE_SPEC.nodes.fanOutSubtasks;
    if (fan?.type === 'fanOut') {
      expect(fan.pluck).toBe('result.branch');
    }
  });

  it('fan-out blocks on the first failing branch', () => {
    const fan = PER_BRANCH_GATES_EXAMPLE_SPEC.nodes.fanOutSubtasks;
    if (fan?.type === 'fanOut') {
      expect(fan.onBranchFail).toBe('block');
    }
  });
});
