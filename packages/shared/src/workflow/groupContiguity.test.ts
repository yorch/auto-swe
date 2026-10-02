import { describe, expect, it } from 'vitest';
import { parseWorkflowSpec } from './spec.js';
import { splitGroups, validateSpec } from './validateSpec.js';

function spec(nodes: Record<string, unknown>, entry = 'a') {
  return parseWorkflowSpec({ entry, name: 'test', nodes, schemaVersion: 1 });
}

const grouped = (groups: Record<string, string | undefined>) =>
  spec({
    a: { group: groups.a, next: 'b', step: 'runLint', type: 'step' },
    b: { group: groups.b, next: 'c', step: 'runLint', type: 'step' },
    c: { group: groups.c, next: 'd', step: 'runLint', type: 'step' },
    d: { group: groups.d, status: 'SUCCESS', type: 'terminate' },
  });
const codes = (s: ReturnType<typeof spec>) => validateSpec(s).warnings.map((w) => w.code);

describe('validateSpec group contiguity', () => {
  it('is quiet when nothing is grouped', () => {
    expect(codes(grouped({}))).not.toContain('GROUP_NOT_CONTIGUOUS');
  });

  it('is quiet for a group that is one connected run of nodes', () => {
    expect(codes(grouped({ b: 'review', c: 'review' }))).not.toContain('GROUP_NOT_CONTIGUOUS');
  });

  it('warns, advisory only, when a group is split by a node outside it', () => {
    const report = validateSpec(grouped({ a: 'review', c: 'review' }));
    const w = report.warnings.find((x) => x.code === 'GROUP_NOT_CONTIGUOUS');
    expect(w?.message).toContain("group 'review'");
    expect(w?.nodeId).toBe('c');
    expect(w?.severity).toBe('warning');
    expect(report.errors).toEqual([]);
  });

  it('keeps separate labels separate', () => {
    expect(codes(grouped({ a: 'x', b: 'x', c: 'y', d: 'y' }))).not.toContain(
      'GROUP_NOT_CONTIGUOUS'
    );
  });

  it('counts a back-edge as connecting the group', () => {
    const loop = spec({
      a: { group: 'loop', next: 'b', step: 'runLint', type: 'step' },
      b: { expr: 'x == 1', group: 'loop', onFalse: 'a', onTrue: 'end', type: 'cond' },
      end: { status: 'SUCCESS', type: 'terminate' },
    });
    expect(codes(loop)).not.toContain('GROUP_NOT_CONTIGUOUS');
  });

  it('splitGroups reports only the groups that fall apart, as their pieces', () => {
    const split = splitGroups(grouped({ a: 'review', b: 'ok', c: 'review', d: 'ok' }));
    expect([...split.keys()].sort()).toEqual(['ok', 'review']);
    expect(split.get('review')).toEqual([['a'], ['c']]);
    expect([...splitGroups(grouped({ a: 'x', b: 'x' })).keys()]).toEqual([]);
  });
});
