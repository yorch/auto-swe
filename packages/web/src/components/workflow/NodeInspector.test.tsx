// @vitest-environment jsdom

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

/** Open a dropdown by its label and return the options it offers. */
function openSelect(label: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }));
  return screen.getAllByRole('option');
}

function pick(label: string, option: string) {
  openSelect(label);
  fireEvent.click(screen.getByRole('option', { name: option }));
}

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

    pick('Ship it', 'b');

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

    expect(screen.getByRole('button', { name: /Ship it/i }).textContent).toContain('a');
    expect(screen.getByRole('button', { name: /Hold/i }).textContent).toContain('b');
  });

  it('offers no "none" for a schema-required edge', () => {
    // Every `humanDecision` edge is required, so clearing one is not a choice
    // the spec can represent — the dropdown must not offer it.
    for (const label of ['Ship it', 'Hold', 'On timeout']) {
      // A fresh render per dropdown, so only one list is ever open.
      cleanup();
      renderInspector(DECISION, 'decide');
      const options = openSelect(label).map((o) => o.textContent?.replace('✓', ''));
      expect(options).toEqual(['decide', 'a', 'b'].filter((id) => id !== 'decide'));
    }
  });

  it('still offers "none" for an optional edge, and clears it', () => {
    const onChangeNode = renderInspector(STEP, 'work');
    expect(openSelect('Next').map((o) => o.textContent?.replace('✓', ''))).toEqual([
      'Not connected',
      'a',
      'b',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Not connected' }));

    expect(onChangeNode).toHaveBeenCalledWith({ step: 'doThing', type: 'step' });
  });
});
