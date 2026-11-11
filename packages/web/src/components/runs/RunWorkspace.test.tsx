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
  }: {
    onSelect: (id: string) => void;
    selectedNodeId: string | null;
  }) => (
    <button onClick={() => onSelect('impl')} type="button">
      graph:{selectedNodeId}
    </button>
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
];
const run = {
  endedAt: at(30),
  id: 'r1',
  startedAt: at(0),
  status: 'SUCCESS',
  steps,
  traces,
} as unknown as WorkflowRunDetail;
function Harness({ jumpNonce = 0 }: { jumpNonce?: number }) {
  const [selected, setSelected] = useState<string | null>('impl');
  return (
    <RunWorkspace
      activity={<p>activity</p>}
      dagOverlay={undefined}
      details={<p>latest metadata</p>}
      evidence={<p>artifacts</p>}
      jumpNonce={jumpNonce}
      linker={linker}
      needsDecision={false}
      overview={<p>approval context</p>}
      run={run}
      selectedNodeId={selected}
      setSelectedNodeId={setSelected}
      spec={spec}
      traces={traces}
    />
  );
}
describe('linked run workspace', () => {
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
