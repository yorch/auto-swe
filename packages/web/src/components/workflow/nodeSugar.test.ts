import { nodeEdges, parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { foldedGroupId, foldGroups } from './foldGroups';
import { parseMaxVisits, withField } from './inspectorFlow';
import { nodeFlowNotes } from './nodeDisplay';
import { buildOutline, flowOrder } from './outline';
import { deleteNodeFromSpec, renameNodeInSpec, setSpecEdge } from './specEdits';
import { specToFlow } from './specToFlow';

const spec = (nodes: Record<string, unknown>, entry = 'a') =>
  parseWorkflowSpec({ entry, name: 't', nodes, schemaVersion: 1 });

const done = { status: 'SUCCESS', type: 'terminate' };
const SPEC = spec({
  a: {
    maxVisits: 3,
    next: 'done',
    onExhausted: 'giveup',
    onFailure: 'fix',
    status: 'Working',
    step: 's',
    type: 'step',
  },
  b: { next: 'done', onFailure: { message: 'no', status: 'FAILED' }, step: 's', type: 'step' },
  done,
  fix: { next: 'done', step: 'f', type: 'step' },
  giveup: { status: 'FAILED', type: 'terminate' },
});

describe('new edges in structural edits', () => {
  it('renames a target in onFailure / onExhausted', () => {
    const r = renameNodeInSpec(SPEC, 'fix', 'repair');
    expect((r.nodes.a as { onFailure?: string }).onFailure).toBe('repair');
    const g = renameNodeInSpec(SPEC, 'giveup', 'stop');
    expect((g.nodes.a as { onExhausted?: string }).onExhausted).toBe('stop');
  });

  it('clears the edge when the target is deleted, leaving no dangling id', () => {
    const r = deleteNodeFromSpec(deleteNodeFromSpec(SPEC, 'fix'), 'giveup');
    const a = r.nodes.a as Record<string, unknown>;
    expect(a.onFailure).toBeUndefined();
    expect(a.onExhausted).toBeUndefined();
    expect(() => parseWorkflowSpec(r)).not.toThrow();
    for (const n of Object.values(r.nodes)) {
      for (const [, to] of nodeEdges(n)) {
        expect(r.nodes[to]).toBeDefined();
      }
    }
  });

  it('leaves the terminal shorthand alone through rename and delete', () => {
    const r = deleteNodeFromSpec(renameNodeInSpec(SPEC, 'done', 'end'), 'fix');
    expect((r.nodes.b as { onFailure?: unknown }).onFailure).toEqual({
      message: 'no',
      status: 'FAILED',
    });
  });

  it('connects and disconnects through setSpecEdge', () => {
    const on = setSpecEdge(SPEC, 'b', 'onFailure', 'fix');
    expect((on.nodes.b as { onFailure?: unknown }).onFailure).toBe('fix');
    const off = setSpecEdge(on, 'b', 'onFailure', null);
    expect('onFailure' in off.nodes.b).toBe(false);
  });
});

describe('inspector helpers', () => {
  it('withField removes a key when cleared', () => {
    const cleared = withField(SPEC.nodes.a, 'status', '');
    expect('status' in cleared).toBe(false);
    expect(withField(SPEC.nodes.a, 'storeAs', 'context.x')).toMatchObject({ storeAs: 'context.x' });
  });
  it('parseMaxVisits accepts whole numbers 1..10000 only', () => {
    expect(parseMaxVisits(' 3 ')).toBe(3);
    for (const bad of ['', '0', '1.5', 'x', '10001', '-2']) {
      expect(parseMaxVisits(bad)).toBeUndefined();
    }
  });
});

describe('card notes', () => {
  it('shows status, visit limit and the terminal shorthand as text', () => {
    expect(nodeFlowNotes(SPEC.nodes.a)).toEqual({
      chips: [],
      maxVisits: 'max 3 visits',
      status: 'Working',
    });
    expect(nodeFlowNotes(SPEC.nodes.b).chips).toEqual(['on failure: stop FAILED']);
    expect(nodeFlowNotes(SPEC.nodes.done)).toEqual({ chips: [] });
  });
});

describe('graph and outline', () => {
  it('draws string routes as dashed edges and the shorthand as no edge', () => {
    const { edges } = specToFlow(SPEC);
    const failure = edges.find((e) => e.source === 'a' && e.sourceHandle === 'onFailure');
    const exhausted = edges.find((e) => e.source === 'a' && e.sourceHandle === 'onExhausted');
    expect(failure?.style?.strokeDasharray).toBeTruthy();
    expect(exhausted?.label).toBe('out of attempts');
    expect(edges.filter((e) => e.source === 'b')).toHaveLength(1);
  });

  it('lists the failure and exhausted targets in the outline', () => {
    expect(flowOrder(SPEC)).toEqual(expect.arrayContaining(['fix', 'giveup']));
    expect(buildOutline(SPEC).flatMap((s) => s.nodeIds)).toContain('giveup');
  });

  it('a folded group keeps the failure exit and stays closed', () => {
    const s = spec(
      {
        a: { group: 'g', next: 'b', onFailure: 'fix', step: 'x', type: 'step' },
        b: { group: 'g', next: 'done', step: 'x', type: 'step' },
        done,
        fix: { next: 'done', step: 'x', type: 'step' },
      },
      'a'
    );
    const fold = foldGroups(s, new Set(['g']));
    const card = fold.folded[foldedGroupId('g')];
    expect(card?.exits.map((e) => e.to).sort()).toEqual(['done', 'fix']);
    for (const n of Object.values(fold.spec.nodes)) {
      for (const [, to] of nodeEdges(n)) {
        expect(fold.spec.nodes[to]).toBeDefined();
      }
    }
  });

  it('retargets an outside onFailure that points into a folded group', () => {
    const s = spec(
      {
        a: { next: 'done', onFailure: 'g1', step: 'x', type: 'step' },
        done,
        g1: { group: 'g', next: 'g2', step: 'x', type: 'step' },
        g2: { group: 'g', next: 'done', step: 'x', type: 'step' },
      },
      'a'
    );
    const fold = foldGroups(s, new Set(['g']));
    expect((fold.spec.nodes.a as { onFailure?: string }).onFailure).toBe(foldedGroupId('g'));
  });
});
