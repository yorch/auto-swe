// @vitest-environment jsdom

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NodeInspector } from './NodeInspector';

/**
 * The outgoing-edge dropdowns are addressed by spec field name, and a decision
 * option's field name is `options[i].next` — an indexed path into an array, not
 * a top-level key. The inspector used to assign it as one, which wrote a literal
 * `"options[0].next"` property onto the node and left the real routing alone:
 * the dropdown read back correctly and the save silently did nothing.
 *
 * These render the real component and pin what `onChangeNode` receives.
 */

const DECISION: SpecNode = {
  onTimeout: 'b',
  options: [
    { label: 'Ship it', next: 'a', value: 'ship' },
    { label: 'Hold', next: 'b', value: 'hold' },
  ],
  timeout: '1h',
  title: 'Pick one',
  type: 'humanDecision',
};

const STEP: SpecNode = { next: 'a', step: 'doThing', type: 'step' };

function renderInspector(node: SpecNode, nodeId: string, onChangeNode = vi.fn()) {
  render(
    <NodeInspector
      allNodeIds={[nodeId, 'a', 'b']}
      isEntry={false}
      node={node}
      nodeId={nodeId}
      onChangeNode={onChangeNode}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      stepMeta={null}
      stepRegistry={[]}
    />
  );
  return onChangeNode;
}

describe('NodeInspector outgoing edges', () => {
  it('retargets a decision option in place, not as a top-level key', () => {
    const onChangeNode = renderInspector(DECISION, 'decide');

    fireEvent.change(screen.getByLabelText('Ship it'), { target: { value: 'b' } });

    expect(onChangeNode).toHaveBeenCalledTimes(1);
    const next = onChangeNode.mock.calls[0]?.[0] as SpecNode;
    expect(Object.keys(next)).not.toContain('options[0].next');
    expect(next.type === 'humanDecision' && next.options).toEqual([
      { label: 'Ship it', next: 'b', value: 'ship' },
      { label: 'Hold', next: 'b', value: 'hold' },
    ]);
  });

  it('shows an option edge as the port it belongs to, not the whole node', () => {
    renderInspector(DECISION, 'decide');

    expect((screen.getByLabelText('Ship it') as HTMLSelectElement).value).toBe('a');
    expect((screen.getByLabelText('Hold') as HTMLSelectElement).value).toBe('b');
  });

  it('offers no "none" for a schema-required edge', () => {
    renderInspector(DECISION, 'decide');

    // Every `humanDecision` edge is required, so clearing one is not a choice
    // the spec can represent — the dropdown must not offer it.
    for (const label of ['Ship it', 'Hold', 'On timeout']) {
      const options = [...(screen.getByLabelText(label) as HTMLSelectElement).options].map(
        (o) => o.value
      );
      expect(options).toEqual(['decide', 'a', 'b'].filter((id) => id !== 'decide'));
    }
  });

  it('still offers "none" for an optional edge, and clears it', () => {
    const onChangeNode = renderInspector(STEP, 'work');
    const select = screen.getByLabelText('Next') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'a', 'b']);

    fireEvent.change(select, { target: { value: '' } });

    expect(onChangeNode).toHaveBeenCalledWith({ step: 'doThing', type: 'step' });
  });
});
