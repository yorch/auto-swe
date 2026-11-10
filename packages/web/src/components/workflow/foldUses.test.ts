import { nodeEdges, parseWorkflowSpec, type WorkflowSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import {
  collapsibleGroups,
  collapsibleUses,
  defaultCollapsed,
  foldedGroupId,
  foldedUseId,
  foldGroups,
  macroUseFoldKey,
} from './foldGroups';
import { macroSpec } from './macroTestSpec';
import { specToFlow } from './specToFlow';

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
}

const CI = macroUseFoldKey('ci');
const PR = macroUseFoldKey('pr');

describe('folding macro uses', () => {
  const spec = macroSpec();

  it('offers each connected use of two or more nodes', () => {
    expect(collapsibleUses(spec)).toEqual(['pr', 'ci']);
    expect(foldGroups(spec, new Set()).collapsible).toEqual([PR, CI, ...collapsibleGroups(spec)]);
  });

  it('folds one use into one card titled by its macro, across the groups it spans', () => {
    const fold = foldGroups(spec, new Set([CI]));
    const card = fold.folded[foldedUseId('ci')];
    expect(card).toMatchObject({
      group: 'ci',
      key: CI,
      kind: 'use',
      memberIds: ['terminateCITimedOut', 'waitForCI', 'checkCI', 'terminateCIFailed'],
      title: 'CI loop · ci',
    });
    expect(card?.exits).toEqual([{ label: 'done', port: 'exit:done', to: 'done' }]);
    // What led in now leads to the card.
    expect((fold.spec.nodes.savePrInfo as { next?: string }).next).toBe(foldedUseId('ci'));
    expect(fold.spec.nodes.waitForCI).toBeUndefined();
    expect(fold.spec.nodes[foldedUseId('ci')]?.title).toBe('CI loop · ci');
    expectClosed(fold);
  });

  it('leaves the group fold exactly as it was when only group labels are passed', () => {
    const fold = foldGroups(spec, new Set(['CI wait', 'CI loop']));
    expect(Object.keys(fold.folded).sort()).toEqual([
      foldedGroupId('CI loop'),
      foldedGroupId('CI wait'),
    ]);
    expect(fold.folded[foldedGroupId('CI wait')]).toMatchObject({
      group: 'CI wait',
      key: 'CI wait',
      kind: 'group',
      title: 'CI wait',
    });
  });

  it('lets a collapsed use take its members before the groups are judged', () => {
    const fold = foldGroups(spec, defaultCollapsed(spec, true));
    expect(Object.keys(fold.folded)).toEqual([foldedUseId('pr'), foldedUseId('ci')]);
    expect(Object.keys(fold.spec.nodes)).toEqual([
      'start',
      foldedUseId('pr'),
      foldedUseId('ci'),
      'done',
    ]);
    expect(fold.folded[foldedUseId('pr')]?.exits.map((e) => e.label)).toEqual(['CI loop · ci']);
    expectClosed(fold);
  });

  it('keeps a use open when it holds what the viewer is looking at; its groups still fold', () => {
    const fold = foldGroups(spec, defaultCollapsed(spec, true), new Set(['checkCI']));
    expect(fold.folded[foldedUseId('ci')]).toBeUndefined();
    expect(fold.collapsible).not.toContain(CI);
    // `CI loop` holds checkCI and stays open too; `CI wait` folds as a group card.
    expect(fold.folded[foldedGroupId('CI loop')]).toBeUndefined();
    expect(fold.folded[foldedGroupId('CI wait')]).toBeDefined();
    expect(fold.spec.nodes.checkCI).toBeDefined();
    expectClosed(fold);
  });

  it('does not offer a use split by an outside node, or one with a single node', () => {
    const s: WorkflowSpec = parseWorkflowSpec({
      entry: 'a',
      name: 't',
      nodes: {
        a: { next: 'mid', step: 'x', type: 'step', use: 'split' },
        c: { next: 'end', step: 'x', type: 'step', use: 'split' },
        end: { status: 'SUCCESS', type: 'terminate', use: 'lone' },
        mid: { next: 'c', step: 'x', type: 'step' },
      },
      schemaVersion: 1,
    });
    expect(collapsibleUses(s)).toEqual([]);
    const keys = new Set([macroUseFoldKey('split'), macroUseFoldKey('lone')]);
    expect(foldGroups(s, keys).spec).toBe(s);
  });

  it('opens nothing folded unless asked', () => {
    expect(defaultCollapsed(spec, false)).toEqual(new Set());
    expect(defaultCollapsed(spec, true)).toEqual(new Set([PR, CI, ...collapsibleGroups(spec)]));
  });

  it('names the card as a macro for screen readers and on the card', () => {
    const fold = foldGroups(spec, new Set([CI]));
    const { nodes } = specToFlow(fold.spec, { extraEdges: fold.extraEdges, folded: fold.folded });
    const card = nodes.find((n) => n.id === foldedUseId('ci'));
    expect(card?.ariaLabel).toMatch(/^CI loop · ci macro, 4 steps, collapsed/);
    expect(card?.data.folded?.title).toBe('CI loop · ci');
  });
});

describe('the editor canvas', () => {
  it('marks the nodes of a declared use as not deletable on their own', () => {
    const { nodes } = specToFlow(macroSpec(), { editable: true });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get('checkCI')?.deletable).toBe(false);
    expect(byId.get('done')?.deletable).toBeUndefined();
    // The read-only viewer is unaffected.
    expect(
      specToFlow(macroSpec()).nodes.find((n) => n.id === 'checkCI')?.deletable
    ).toBeUndefined();
  });
});
