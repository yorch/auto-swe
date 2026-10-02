import { DEFAULT_ENGINEERING_SPEC, parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { buildOutline, flowOrder, nextOutlineId, outlineIds } from './outline';

const spec = (nodes: Record<string, unknown>, entry: string) =>
  parseWorkflowSpec({ entry, name: 't', nodes, schemaVersion: 1 });

describe('flowOrder', () => {
  it('walks from the entry, reading a cond true branch before its false branch', () => {
    const s = spec(
      {
        c: { expr: 'x == 1', onFalse: 'no', onTrue: 'yes', type: 'cond' },
        end: { status: 'SUCCESS', type: 'terminate' },
        no: { next: 'end', step: 'a', type: 'step' },
        start: { next: 'c', step: 'a', type: 'step' },
        yes: { next: 'end', step: 'a', type: 'step' },
      },
      'start'
    );
    expect(flowOrder(s)).toEqual(['start', 'c', 'yes', 'end', 'no']);
  });

  it('visits a loop once, and lists nodes the walk never reaches after the rest', () => {
    const s = spec(
      {
        a: { next: 'b', step: 'x', type: 'step' },
        b: { expr: 'x == 1', onFalse: 'a', onTrue: 'end', type: 'cond' },
        end: { status: 'SUCCESS', type: 'terminate' },
        orphan: { next: 'end', step: 'x', type: 'step' },
      },
      'a'
    );
    expect(flowOrder(s)).toEqual(['a', 'b', 'end', 'orphan']);
  });
});

describe('buildOutline', () => {
  const grouped = spec(
    {
      a: { group: 'build', next: 'solo', step: 'x', type: 'step' },
      b: { group: 'build', next: 'end', step: 'x', type: 'step' },
      end: { status: 'SUCCESS', type: 'terminate' },
      solo: { next: 'b', step: 'x', type: 'step' },
    },
    'a'
  );

  it('places a group where the walk first meets it, keeping the group together', () => {
    // flow order is a, solo, b — but `build` is one section, so b joins a.
    expect(buildOutline(grouped)).toEqual([
      { group: 'build', nodeIds: ['a', 'b'] },
      { group: null, nodeIds: ['solo'] },
      { group: null, nodeIds: ['end'] },
    ]);
  });

  it('lists every node exactly once', () => {
    const ids = outlineIds(buildOutline(grouped));
    expect([...ids].sort()).toEqual(Object.keys(grouped.nodes).sort());
  });

  it('shows a spec with no groups at all as a plain flow-ordered list', () => {
    const plain = spec(
      {
        a: { next: 'b', step: 'x', type: 'step' },
        b: { next: 'end', step: 'x', type: 'step' },
        end: { status: 'SUCCESS', type: 'terminate' },
      },
      'a'
    );
    expect(buildOutline(plain).map((s) => s.group)).toEqual([null, null, null]);
    expect(outlineIds(buildOutline(plain))).toEqual(['a', 'b', 'end']);
  });

  it('outlines the seeded default-engineering template by phase, every node once', () => {
    const sections = buildOutline(DEFAULT_ENGINEERING_SPEC);
    const labels = sections.map((s) => s.group);
    // The first phases, in the order a run meets them.
    expect(labels.slice(0, 4)).toEqual(['validate', 'implement', 'review loop', 'pull request']);
    expect(labels).toContain('CI loop');
    expect(labels).toContain('human merge');
    expect(outlineIds(sections).sort()).toEqual(Object.keys(DEFAULT_ENGINEERING_SPEC.nodes).sort());
  });
});

describe('nextOutlineId', () => {
  const ids = ['a', 'b', 'c'];
  it('moves down and up, and stops at the ends', () => {
    expect(nextOutlineId(ids, 'a', 'ArrowDown')).toBe('b');
    expect(nextOutlineId(ids, 'b', 'ArrowUp')).toBe('a');
    expect(nextOutlineId(ids, 'a', 'ArrowUp')).toBeNull();
    expect(nextOutlineId(ids, 'c', 'ArrowDown')).toBeNull();
  });

  it('jumps with Home and End', () => {
    expect(nextOutlineId(ids, 'b', 'Home')).toBe('a');
    expect(nextOutlineId(ids, 'b', 'End')).toBe('c');
  });

  it('starts at an end when nothing is focused, or the focused row is not showing', () => {
    expect(nextOutlineId(ids, null, 'ArrowDown')).toBe('a');
    expect(nextOutlineId(ids, null, 'ArrowUp')).toBe('c');
    expect(nextOutlineId(ids, 'gone', 'ArrowDown')).toBe('a');
  });

  it('has nowhere to go in an empty outline', () => {
    expect(nextOutlineId([], null, 'ArrowDown')).toBeNull();
  });
});
