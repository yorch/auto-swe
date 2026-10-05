// @vitest-environment jsdom

import type { AgentTraceRecord, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow/spec';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildTraceLinker } from '@/lib/traceLinkage';
import { SplitRunPanel } from './SplitRunPanel';

const linker = buildTraceLinker(
  parseWorkflowSpec({
    entry: 'fan',
    name: 'split',
    nodes: {
      done: { status: 'SUCCESS', type: 'terminate' },
      fan: { join: 'done', over: { literal: [1, 2] }, subgraph: 'impl', type: 'fanOut' },
      impl: { next: 'done', step: 'executeImplementation', type: 'step' },
    },
    schemaVersion: SPEC_SCHEMA_VERSION,
  })
);

const step = (id: string, nodeId: string): WorkflowStepRecord => ({
  attempt: 1,
  endedAt: null,
  error: null,
  id,
  inputs: null,
  nodeId,
  outputs: null,
  startedAt: null,
  status: 'PASSED',
});

const trace = (id: string, recordingId: string): AgentTraceRecord => ({
  agentKey: 'implementer',
  attempt: 1,
  costUsd: null,
  createdAt: '2026-01-01T00:00:00Z',
  durationMs: 1,
  error: null,
  id,
  inputJson: null,
  inputTokens: null,
  model: null,
  nodeId: 'executeImplementation',
  otelSpanId: null,
  otelTraceId: null,
  outputJson: null,
  outputTokens: null,
  recordingId,
  seq: 0,
  specNodeId: 'impl',
  stepAttempt: 1,
  toolName: null,
  trimmed: false,
  type: 'activity_event',
});

const steps = [step('s0', 'fan'), step('s1', 'fan[0]/impl'), step('s2', 'fan[1]/impl')];
const traces = [trace('t0', 'fan[0]/impl'), trace('t1', 'fan[1]/impl')];

function renderPanel(selectedNodeId: string | null, onSelectNode = vi.fn()) {
  render(
    <SplitRunPanel
      linker={linker}
      onSelectNode={onSelectNode}
      selectedNodeId={selectedNodeId}
      steps={steps}
      traces={traces}
    />
  );
  return onSelectNode;
}

const rows = () => screen.getAllByRole('button').filter((b) => b.textContent?.includes('×'));

describe('SplitRunPanel', () => {
  it('selects the recording id of a branch step, which narrows the traces to that branch', () => {
    const onSelectNode = renderPanel(null);
    fireEvent.click(rows()[1] as HTMLElement);
    expect(onSelectNode).toHaveBeenCalledWith('fan[0]/impl');
  });

  it('highlights every branch of a node chosen on the graph, and only those', () => {
    renderPanel('impl');
    const [fan, b0, b1] = rows();
    expect(fan?.className).not.toContain('border-ember-400');
    expect(b0?.className).toContain('border-ember-400');
    expect(b1?.className).toContain('border-ember-400');
  });

  it('highlights a fan-out node together with its branch steps', () => {
    renderPanel('fan');
    expect(rows().every((r) => r.className.includes('border-ember-400'))).toBe(true);
  });

  it('highlights only the chosen branch when a branch step is selected', () => {
    renderPanel('fan[1]/impl');
    const [fan, b0, b1] = rows();
    expect(fan?.className).not.toContain('border-ember-400');
    expect(b0?.className).not.toContain('border-ember-400');
    expect(b1?.className).toContain('border-ember-400');
    expect(screen.getAllByTestId('trace-branch').map((el) => el.textContent)).toEqual([
      'Branch fan[1]',
    ]);
  });

  it('sets the branch path apart from the node id in the row', () => {
    renderPanel(null);
    expect(rows()[1]?.textContent).toContain('fan[0]/impl');
  });

  it('clears the selection when the selected step is clicked again', () => {
    const onSelectNode = renderPanel('fan[0]/impl');
    fireEvent.click(rows()[1] as HTMLElement);
    expect(onSelectNode).toHaveBeenCalledWith(null);
  });
});
