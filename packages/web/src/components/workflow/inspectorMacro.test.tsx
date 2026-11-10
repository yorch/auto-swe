// @vitest-environment jsdom

import { collectUseProblems, type WorkflowSpec } from '@auto-swe/shared/workflow';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { macroSpec } from './macroTestSpec';
import { NodeInspector } from './NodeInspector';

afterEach(cleanup);

function renderFor(spec: WorkflowSpec, nodeId: string, onChangeSpec = vi.fn()) {
  render(
    <NodeInspector
      allNodeIds={Object.keys(spec.nodes)}
      isEntry={nodeId === spec.entry}
      node={spec.nodes[nodeId] ?? null}
      nodeId={nodeId}
      onChangeNode={vi.fn()}
      onChangeSpec={onChangeSpec}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      spec={spec}
      stepMeta={null}
      stepRegistry={[]}
    />
  );
  return onChangeSpec;
}

describe('the Macro section', () => {
  it('is shown only for a node tagged with a use', () => {
    renderFor(macroSpec(), 'done');
    expect(screen.queryByRole('heading', { name: 'Macro' })).toBeNull();
  });

  it('shows the use and locks delete and rename', () => {
    renderFor(macroSpec(), 'checkCI');
    expect(screen.getByRole('heading', { name: 'Macro' })).toBeTruthy();
    expect(screen.getByText('ciLoop@1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete node checkCI' })).toHaveProperty(
      'disabled',
      true
    );
    expect(screen.getByLabelText('Node ID')).toHaveProperty('readOnly', true);
  });

  it("shows the schema's error and disables Re-expand until the arguments are valid", () => {
    renderFor(macroSpec(), 'checkCI');
    const args = screen.getByLabelText('Arguments');
    fireEvent.change(args, { target: { value: '{"fix": false, "passed": 5}' } });
    expect(screen.getByText(/^passed: /)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-expand' })).toHaveProperty('disabled', true);
  });

  it('re-expands with edited arguments through the spec change', () => {
    const onChangeSpec = renderFor(macroSpec(), 'checkCI');
    fireEvent.change(screen.getByLabelText('Arguments'), {
      target: { value: '{"fix": false, "passed": "done", "wait": "pollOrSignal"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Re-expand' }));
    const next = onChangeSpec.mock.calls[0]?.[0] as WorkflowSpec;
    expect(next.nodes.loadCiWaitConfig).toBeDefined();
    expect(collectUseProblems(next)).toEqual([]);
  });

  it('explains drift and detaches', () => {
    const base = macroSpec();
    const drifted: WorkflowSpec = {
      ...base,
      nodes: { ...base.nodes, checkCI: { ...base.nodes.checkCI, expr: 'false' } as never },
    };
    const onChangeSpec = renderFor(drifted, 'checkCI');
    expect(screen.getByText('Edited by hand')).toBeTruthy();
    expect(screen.getByText(/a save is refused/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Detach' }));
    const next = onChangeSpec.mock.calls[0]?.[0] as WorkflowSpec;
    expect(next.uses?.ci).toBeUndefined();
    expect(next.nodes.checkCI?.use).toBeUndefined();
  });
});
