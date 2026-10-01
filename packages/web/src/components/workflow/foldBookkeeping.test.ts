import { DEFAULT_ENGINEERING_SPEC, parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { foldBookkeeping } from './foldBookkeeping';

const spec = (nodes: Record<string, unknown>, entry: string) =>
  parseWorkflowSpec({ entry, name: 't', nodes, schemaVersion: 1 });

describe('foldBookkeeping', () => {
  it('routes edges through a chain of set / updateDomainState nodes', () => {
    const s = spec(
      {
        a: { next: 's1', step: 'executeImplementation', type: 'step' },
        done: { status: 'SUCCESS', type: 'terminate' },
        s1: { next: 's2', type: 'set', values: { 'context.x': { literal: 1 } } },
        s2: { config: { status: 'X' }, next: 'done', step: 'updateDomainState', type: 'step' },
      },
      'a'
    );
    const { spec: folded, hidden } = foldBookkeeping(s);
    expect(hidden.sort()).toEqual(['s1', 's2']);
    expect(Object.keys(folded.nodes).sort()).toEqual(['a', 'done']);
    expect((folded.nodes.a as { next?: string }).next).toBe('done');
  });

  it('rewrites branch edges, not just next', () => {
    const s = spec(
      {
        c: { expr: 'context.x == 1', onFalse: 's', onTrue: 'done', type: 'cond' },
        done: { status: 'SUCCESS', type: 'terminate' },
        s: { next: 'done', type: 'set', values: { 'context.x': { literal: 1 } } },
      },
      'c'
    );
    const { spec: folded } = foldBookkeeping(s);
    expect(folded.nodes.c).toMatchObject({ onFalse: 'done', onTrue: 'done' });
  });

  it('keeps the entry node and any node it was told to keep', () => {
    const s = spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        s1: { next: 's2', type: 'set', values: { 'context.x': { literal: 1 } } },
        s2: { next: 'done', type: 'set', values: { 'context.y': { literal: 1 } } },
      },
      's1'
    );
    const { spec: folded, hidden } = foldBookkeeping(s, new Set(['s2']));
    expect(hidden).toEqual([]);
    expect(Object.keys(folded.nodes).sort()).toEqual(['done', 's1', 's2']);
  });

  it('leaves a bookkeeping cycle alone instead of looping forever', () => {
    const s = spec(
      {
        a: { next: 's1', step: 'executeImplementation', type: 'step' },
        done: { status: 'SUCCESS', type: 'terminate' },
        s1: { next: 's2', type: 'set', values: { 'context.x': { literal: 1 } } },
        s2: { next: 's1', type: 'set', values: { 'context.y': { literal: 1 } } },
      },
      'a'
    );
    const { spec: folded } = foldBookkeeping(s);
    expect(folded.nodes.s1).toBeDefined();
    expect(folded.nodes.s2).toBeDefined();
  });

  it('does not fold a set node that ends a branch (no next)', () => {
    const s = spec(
      {
        a: { next: 'end', step: 'executeImplementation', type: 'step' },
        end: { type: 'set', values: { 'context.x': { literal: 1 } } },
      },
      'a'
    );
    expect(foldBookkeeping(s).hidden).toEqual([]);
  });

  it('shrinks the default engineering template and keeps every non-bookkeeping node', () => {
    const { spec: folded, hidden } = foldBookkeeping(DEFAULT_ENGINEERING_SPEC);
    expect(hidden.length).toBeGreaterThan(10);
    for (const [id, node] of Object.entries(DEFAULT_ENGINEERING_SPEC.nodes)) {
      if (!hidden.includes(id)) {
        expect(folded.nodes[id]?.type).toBe(node.type);
      }
    }
    // Every edge in the folded spec still lands on a node that exists.
    const parsed = parseWorkflowSpec(JSON.parse(JSON.stringify(folded)));
    expect(parsed.entry).toBe(DEFAULT_ENGINEERING_SPEC.entry);
  });
});
