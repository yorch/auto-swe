// @vitest-environment jsdom

import type {
  AgentTraceRecord,
  WorkflowRunDetail,
  WorkflowStepRecord,
} from '@auto-swe/shared/types/api';
import { parseWorkflowSpec } from '@auto-swe/shared/workflow/spec';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTraceLinker, traceMatchesSelection } from '@/lib/traceLinkage';
import { RunWorkspace } from './RunWorkspace';

vi.mock('@/components/workflow/WorkflowDag', () => ({
  WorkflowDag: ({
    onSelect,
    selectedNodeId,
    toggleSelection = true,
  }: {
    onSelect: (id: string | null) => void;
    selectedNodeId: string | null;
    toggleSelection?: boolean;
  }) => (
    <>
      <button
        onClick={() => onSelect(toggleSelection && selectedNodeId === 'impl' ? null : 'impl')}
        type="button"
      >
        graph:{selectedNodeId}
      </button>
      <button onClick={() => onSelect(null)} type="button">
        Clear graph selection
      </button>
    </>
  ),
}));
vi.mock('@/components/ui/Select', () => ({
  Select: ({
    options,
    value,
    onChange,
    'aria-label': label,
  }: {
    options: { label: string; value: string }[];
    value: string;
    onChange: (v: string) => void;
    'aria-label': string;
  }) => (
    <select aria-label={label} onChange={(e) => onChange(e.target.value)} value={value}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('./TracesTab', () => ({
  TracesTab: ({
    traces,
    filterNodeId,
    linker,
  }: {
    traces: AgentTraceRecord[];
    filterNodeId: string | null;
    linker: ReturnType<typeof buildTraceLinker>;
  }) => (
    <div data-testid="events">
      {traces
        .filter((t) => !filterNodeId || traceMatchesSelection(t, filterNodeId, linker))
        .map((t) => t.id)
        .join(',')}
    </div>
  ),
}));
afterEach(cleanup);
const spec = parseWorkflowSpec({
  entry: 'fan',
  name: 'test',
  nodes: {
    done: { status: 'SUCCESS', type: 'terminate' },
    fan: { join: 'done', over: { literal: [1, 2] }, subgraph: 'impl', type: 'fanOut' },
    impl: { next: 'done', step: 'executeImplementation', type: 'step' },
  },
  schemaVersion: 1,
});
const linker = buildTraceLinker(spec);
const at = (s: number) => new Date(Date.parse('2026-11-01T12:00:00Z') + s * 1000).toISOString();
function step(id: string, nodeId: string, attempt: number): WorkflowStepRecord {
  return {
    attempt,
    endedAt: at(attempt * 10 + 5),
    error: null,
    id,
    inputs: null,
    nodeId,
    outputs: null,
    startedAt: at(attempt * 10),
    status: 'PASSED',
  };
}
const steps = [
  step('s0', 'fan[0]/impl', 1),
  step('s1', 'fan[1]/impl', 1),
  step('s2', 'fan[0]/impl', 2),
];
function trace(id: string, recordingId: string, attempt: number): AgentTraceRecord {
  return {
    agentKey: 'implementer',
    attempt: 1,
    costUsd: null,
    createdAt: at(attempt * 10 + 2),
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
    seq: attempt,
    specNodeId: 'impl',
    stepAttempt: attempt,
    toolName: null,
    trimmed: false,
    type: 'activity_event',
  };
}
const traces = [
  trace('t0', 'fan[0]/impl', 1),
  trace('t1', 'fan[1]/impl', 1),
  trace('t2', 'fan[0]/impl', 2),
  { ...trace('outside', 'fan', 1), specNodeId: 'fan' },
];
const run = {
  endedAt: at(30),
  id: 'r1',
  startedAt: at(0),
  status: 'SUCCESS',
  steps,
  traces,
} as unknown as WorkflowRunDetail;
function Harness({
  jumpNonce = 0,
  currentRun = run,
  monitoringPaused = false,
}: {
  jumpNonce?: number;
  currentRun?: WorkflowRunDetail;
  monitoringPaused?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>('impl');
  return (
    <RunWorkspace
      activity={<p>activity</p>}
      dagOverlay={undefined}
      details={<p>latest metadata</p>}
      evidence={<p>artifacts</p>}
      jumpNonce={jumpNonce}
      linker={linker}
      monitoringPaused={monitoringPaused}
      needsDecision={false}
      overview={<p>approval context</p>}
      run={currentRun}
      selectedNodeId={selected}
      setSelectedNodeId={setSelected}
      spec={spec}
      traces={currentRun.traces}
    />
  );
}
describe('linked run workspace', () => {
  it('focuses the phone execution chooser and restores Steps after selection, Back, or Escape', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Steps' });
    const chooser = screen.getByRole('complementary', { name: 'Execution steps' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(chooser);
    const row = within(chooser)
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('fan[0]/impl · attempt 2')) as HTMLElement;
    row.focus();
    fireEvent.click(row);
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByTestId('events').textContent).toBe('t2');
    fireEvent.click(trigger);
    fireEvent.keyDown(chooser, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByTestId('events').textContent).toBe('t2');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Back to evidence' }));
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByTestId('events').textContent).toBe('t2');
  });
  it('renders running timing at a zero-duration paused boundary without marking it not started', () => {
    const currentRun = {
      ...run,
      endedAt: null,
      status: 'RUNNING' as const,
      steps: [{ ...steps[0], endedAt: null, startedAt: at(0), status: 'RUNNING' as const }],
      traces: [],
    };
    render(<Harness currentRun={currentRun} monitoringPaused />);
    fireEvent.click(screen.getByRole('button', { name: 'Timing' }));
    expect(screen.getByText('Paused snapshot')).toBeTruthy();
    expect(screen.getByText('0:00 / 0:00')).toBeTruthy();
    expect(screen.queryByText(/not started at this point/)).toBeNull();
    expect(screen.getByText(/0s · running/)).toBeTruthy();
    expect(screen.getByText(/Open steps may still be running/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review history' }));
    expect(screen.queryByText(/not started at this point/)).toBeNull();
    expect(screen.getByText(/0s · running/)).toBeTruthy();
  });
  it('selects a branch and attempt and preserves it across investigation views', () => {
    render(<Harness />);
    const execution = screen.getByRole('complementary', { name: 'Execution steps' });
    fireEvent.click(
      within(execution)
        .getAllByRole('button')
        .find((b) => b.textContent?.includes('fan[0]/impl · attempt 2')) as HTMLElement
    );
    expect(screen.getByTestId('events').textContent).toBe('t2');
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    expect(screen.getByRole('button', { name: 'graph:impl' })).toBeTruthy();
    expect(screen.getByLabelText('Execution attempt')).toHaveProperty('value', 's2');
    fireEvent.click(screen.getByRole('button', { name: 'Timing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Events' }));
    expect(screen.getByTestId('events').textContent).toBe('t2');
  });
  it('selects all node executions from the graph instead of retaining a stale branch filter', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Execution attempt'), { target: { value: 's0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    fireEvent.click(screen.getByRole('button', { name: 'graph:impl' }));
    expect(screen.getByTestId('events').textContent).toBe('t0,t1,t2');
    const execution = screen.getByRole('complementary', { name: 'Execution steps' });
    expect(
      within(execution)
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    fireEvent.click(screen.getByRole('button', { name: 'graph:impl' }));
    expect(screen.getByTestId('events').textContent).toBe('t0,t1,t2');
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear graph selection' }));
    expect(screen.getByTestId('events').textContent).toBe('t0,t1,t2,outside');
  });
  it('filters historical traces and shows metadata as latest rather than rewinding it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Review history' }));
    expect(screen.getByTestId('events').textContent).toBe('');
    fireEvent.change(screen.getByRole('slider', { name: 'Replay position' }), {
      target: { value: '15000' },
    });
    expect(screen.getByTestId('events').textContent).toBe('t0,t1');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/latest\/final information, not historical/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Return to final state' }));
    fireEvent.click(screen.getByRole('button', { name: 'Events' }));
    expect(screen.getByTestId('events').textContent).toBe('t0,t1,t2');
  });
  it('keeps repeated failure jumps inside the workspace and returns to latest events', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { rerender } = render(<Harness jumpNonce={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    rerender(<Harness jumpNonce={2} />);
    expect(screen.getByRole('button', { name: 'Events' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(scroll).not.toHaveBeenCalled();
  });
});
