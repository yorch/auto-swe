import {
  DEFAULT_ENGINEERING_SPEC,
  nodeEdges,
  parseWorkflowSpec,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { layoutSpec } from '@/lib/workflowLayout';
import { foldBookkeeping } from './foldBookkeeping';
import {
  collapsibleGroups,
  foldedGroupId,
  foldGroups,
  GROUP_STEP,
  isFoldedGroupNode,
} from './foldGroups';

const spec = (nodes: Record<string, unknown>, entry: string) =>
  parseWorkflowSpec({ entry, name: 't', nodes, schemaVersion: 1 });

/** pre -> a -> b -> c -> post, with a/b/c in group `g`. */
const LINE = spec(
  {
    a: { group: 'g', next: 'b', step: 'x', type: 'step' },
    b: { group: 'g', next: 'c', step: 'x', type: 'step' },
    c: { group: 'g', next: 'post', step: 'x', type: 'step' },
    post: { status: 'SUCCESS', type: 'terminate' },
    pre: { next: 'a', step: 'x', type: 'step' },
  },
  'pre'
);

const G = foldedGroupId('g');

/** Every edge, real and extra, lands on a node of the display spec. */
function expectClosed(fold: ReturnType<typeof foldGroups>) {
  for (const node of Object.values(fold.spec.nodes)) {
    for (const [, to] of nodeEdges(node)) {
      expect(fold.spec.nodes[to], `edge to ${to}`).toBeDefined();
    }
  }
  for (const e of fold.extraEdges) {
    expect(fold.spec.nodes[e.from], `extra from ${e.from}`).toBeDefined();
    expect(fold.spec.nodes[e.to], `extra to ${e.to}`).toBeDefined();
  }
  expect(fold.spec.nodes[fold.spec.entry]).toBeDefined();
}

describe('foldGroups', () => {
  it('changes nothing when nothing is collapsed', () => {
    const fold = foldGroups(LINE, new Set());
    expect(fold.spec).toBe(LINE);
    expect(fold.extraEdges).toEqual([]);
    expect(fold.folded).toEqual({});
    expect(fold.collapsible).toEqual(['g']);
  });

  it('turns a collapsed group into one card, rerouting what led in and out', () => {
    const fold = foldGroups(LINE, new Set(['g']));
    expect(Object.keys(fold.spec.nodes).sort()).toEqual(['pre', G, 'post'].sort());
    expect((fold.spec.nodes.pre as { next: string }).next).toBe(G);
    expect(fold.folded[G]).toMatchObject({ group: 'g', memberIds: ['a', 'b', 'c'] });
    expect(fold.extraEdges).toEqual([{ from: G, kind: 'next', port: 'exit:post', to: 'post' }]);
    expect(isFoldedGroupNode(fold.spec.nodes[G])).toBe(true);
    expect(fold.spec.nodes[G]).toMatchObject({ group: 'g', step: GROUP_STEP, type: 'step' });
    expectClosed(fold);
  });

  it('draws one exit per distinct way out of the group', () => {
    const s = spec(
      {
        a: { expr: 'x == 1', group: 'g', onFalse: 'no', onTrue: 'b', type: 'cond' },
        b: { expr: 'y == 1', group: 'g', onFalse: 'no', onTrue: 'yes', type: 'cond' },
        no: { status: 'FAILED', type: 'terminate' },
        yes: { status: 'SUCCESS', type: 'terminate' },
      },
      'a'
    );
    const fold = foldGroups(s, new Set(['g']));
    expect(fold.extraEdges.map((e) => e.to).sort()).toEqual(['no', 'yes']);
    expect(fold.spec.entry).toBe(G);
    expectClosed(fold);
  });

  it('keeps a group open when it holds a node the viewer is looking for', () => {
    for (const looked of ['a', 'b', 'c']) {
      const fold = foldGroups(LINE, new Set(['g']), new Set([looked]));
      expect(fold.spec).toBe(LINE);
      expect(fold.folded).toEqual({});
      // A group forced open is not offered for collapsing either.
      expect(fold.collapsible).toEqual([]);
    }
    // ...while a node outside it forces nothing.
    expect(foldGroups(LINE, new Set(['g']), new Set(['pre'])).folded[G]).toBeDefined();
  });

  it('does not offer a group that is split by a node outside it', () => {
    const split = spec(
      {
        a: { group: 'g', next: 'mid', step: 'x', type: 'step' },
        c: { group: 'g', next: 'end', step: 'x', type: 'step' },
        end: { status: 'SUCCESS', type: 'terminate' },
        mid: { next: 'c', step: 'x', type: 'step' },
      },
      'a'
    );
    expect(collapsibleGroups(split)).toEqual([]);
    expect(foldGroups(split, new Set(['g'])).spec).toBe(split);
  });

  it('does not offer a group of one', () => {
    const lone = spec(
      {
        a: { group: 'g', next: 'end', step: 'x', type: 'step' },
        end: { status: 'SUCCESS', type: 'terminate' },
      },
      'a'
    );
    expect(collapsibleGroups(lone)).toEqual([]);
  });

  it('points one collapsed group at the next when they are adjacent', () => {
    const s = spec(
      {
        a: { group: 'one', next: 'b', step: 'x', type: 'step' },
        b: { group: 'one', next: 'c', step: 'x', type: 'step' },
        c: { group: 'two', next: 'd', step: 'x', type: 'step' },
        d: { group: 'two', next: 'end', step: 'x', type: 'step' },
        end: { status: 'SUCCESS', type: 'terminate' },
      },
      'a'
    );
    const fold = foldGroups(s, new Set(['one', 'two']));
    expect(fold.extraEdges).toEqual([
      {
        from: foldedGroupId('one'),
        kind: 'next',
        port: `exit:${foldedGroupId('two')}`,
        to: foldedGroupId('two'),
      },
      { from: foldedGroupId('two'), kind: 'next', port: 'exit:end', to: 'end' },
    ]);
    expectClosed(fold);
  });

  it('retargets a decision option that led into the group', () => {
    const s = spec(
      {
        a: { group: 'g', next: 'b', step: 'x', type: 'step' },
        b: { group: 'g', next: 'end', step: 'x', type: 'step' },
        decide: {
          onTimeout: 'a',
          options: [
            { label: 'one', next: 'a', value: 'one' },
            { label: 'two', next: 'b', value: 'two' },
          ],
          timeout: '1h',
          title: 'Pick',
          type: 'humanDecision',
        },
        end: { status: 'SUCCESS', type: 'terminate' },
      },
      'decide'
    );
    const fold = foldGroups(s, new Set(['g']));
    expect(fold.spec.nodes.decide).toMatchObject({
      onTimeout: G,
      options: [
        { label: 'one', next: G, value: 'one' },
        { label: 'two', next: G, value: 'two' },
      ],
    });
    expectClosed(fold);
  });

  it('leaves the source spec untouched', () => {
    const before = JSON.stringify(LINE);
    foldGroups(LINE, new Set(['g']));
    expect(JSON.stringify(LINE)).toBe(before);
  });

  it('lays out: the card and its exits become real positioned nodes and edges', () => {
    const fold = foldGroups(LINE, new Set(['g']));
    const layout = layoutSpec(fold.spec, fold.extraEdges);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual([G, 'post', 'pre'].sort());
    expect(layout.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual([`${G}>post`, `pre>${G}`]);
  });
});

describe('foldGroups on the seeded default-engineering template', () => {
  const all = (s: WorkflowSpec) => new Set(collapsibleGroups(s));

  it('collapses every group to a card and stays a closed graph', () => {
    const groups = all(DEFAULT_ENGINEERING_SPEC);
    expect(groups.size).toBeGreaterThan(4);
    const fold = foldGroups(DEFAULT_ENGINEERING_SPEC, groups);
    expect(Object.keys(fold.folded)).toHaveLength(groups.size);
    expect(Object.keys(fold.spec.nodes).length).toBeLessThan(15);
    expectClosed(fold);
    // The graph still lays out with no edge dropped as dangling.
    const layout = layoutSpec(fold.spec, fold.extraEdges);
    const wanted = Object.values(fold.spec.nodes).flatMap((n) => nodeEdges(n)).length;
    expect(layout.edges.length).toBe(wanted + fold.extraEdges.length);
  });

  it('opens just the group that holds a failed node', () => {
    const groups = all(DEFAULT_ENGINEERING_SPEC);
    const fold = foldGroups(DEFAULT_ENGINEERING_SPEC, groups, new Set(['ciFix']));
    expect(Object.keys(fold.folded)).not.toContain(foldedGroupId('CI loop'));
    expect(Object.keys(fold.spec.nodes)).toContain('ciFix');
    expect(Object.keys(fold.folded)).toContain(foldedGroupId('review loop'));
    expectClosed(fold);
  });

  it('composes with the bookkeeping fold, in either order of use', () => {
    const groups = all(DEFAULT_ENGINEERING_SPEC);
    const bookkept = foldBookkeeping(DEFAULT_ENGINEERING_SPEC).spec;
    const fold = foldGroups(bookkept, new Set(collapsibleGroups(bookkept)));
    expectClosed(fold);
    expect(groups.size).toBeGreaterThan(0);
  });

  it('keeps the selected node on screen', () => {
    const fold = foldGroups(
      DEFAULT_ENGINEERING_SPEC,
      all(DEFAULT_ENGINEERING_SPEC),
      new Set(['checkApproval'])
    );
    expect(fold.spec.nodes.checkApproval).toBeDefined();
  });
});
