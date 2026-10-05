// @vitest-environment jsdom

import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow/spec';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTraceLinker } from '@/lib/traceLinkage';
import { clearViewport, mockViewport } from '@/test/matchMedia';
import { FlightRecorder } from './FlightRecorder';
import { SplitConsole } from './SplitConsole';
import { Transcript } from './Transcript';

// The panels are covered by their own tests; here they are markers so the tests read the order
// of the layout's children and the classes the layout itself puts on them.
vi.mock('@/components/runs/RunMetaRail', () => ({
  RunMetaRail: ({ collapsible }: { collapsible?: boolean }) => (
    <aside data-collapsible={String(Boolean(collapsible))} data-testid="rail" />
  ),
}));
vi.mock('@/components/workflow/WorkflowDag', () => ({
  WorkflowDag: () => <div data-testid="dag" />,
}));
vi.mock('@/components/runs/SplitRunPanel', () => ({
  SplitRunPanel: () => <div data-testid="split-panel" />,
}));
vi.mock('@/components/runs/TracesTab', () => ({
  TracesTab: () => <div data-testid="traces" />,
}));

const spec = parseWorkflowSpec({
  entry: 'impl',
  name: 'stack',
  nodes: {
    done: { status: 'SUCCESS', type: 'terminate' },
    impl: { next: 'done', step: 'executeImplementation', type: 'step' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
});

const step: WorkflowStepRecord = {
  attempt: 1,
  endedAt: '2026-10-01T12:04:00Z',
  error: null,
  id: 's0',
  inputs: null,
  nodeId: 'impl',
  outputs: null,
  startedAt: '2026-10-01T12:01:00Z',
  status: 'PASSED',
};

const run = {
  endedAt: '2026-10-01T12:05:00Z',
  startedAt: '2026-10-01T12:00:00Z',
  status: 'SUCCESS',
  steps: [step],
  templateName: 'T',
  templateVersion: 1,
  workRequest: null,
} as unknown as WorkflowRunDetail;

const props = {
  dagOverlay: undefined,
  linker: buildTraceLinker(spec),
  run,
  selectedNodeId: null,
  setSelectedNodeId: vi.fn(),
  spec,
  traces: [],
};

afterEach(() => {
  cleanup();
  clearViewport();
});

/** True when `a` comes before `b` in document order. */
function before(a: HTMLElement, b: HTMLElement): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('Split layout', () => {
  it('stacks the graph, then the collapsible details, then the console below the breakpoint', () => {
    mockViewport(500);
    render(<SplitConsole {...props} />);
    const rail = screen.getByTestId('rail');
    expect(rail.dataset.collapsible).toBe('true');
    expect(before(screen.getByTestId('dag'), rail)).toBe(true);
    expect(before(rail, screen.getByText('Console'))).toBe(true);
  });

  it('keeps the rail last, as a plain column, at desktop width', () => {
    mockViewport(1440);
    render(<SplitConsole {...props} />);
    const rail = screen.getByTestId('rail');
    expect(rail.dataset.collapsible).toBe('false');
    expect(before(screen.getByText('Console'), rail)).toBe(true);
  });

  it('moves the rail when the window crosses the breakpoint', () => {
    const viewport = mockViewport(1440);
    render(<SplitConsole {...props} />);
    expect(screen.getByTestId('rail').dataset.collapsible).toBe('false');
    act(() => viewport.setViewportWidth(700));
    expect(screen.getByTestId('rail').dataset.collapsible).toBe('true');
    expect(before(screen.getByTestId('rail'), screen.getByText('Console'))).toBe(true);
  });

  it('keeps the desktop sizing classes on the graph panel and goes column-first', () => {
    mockViewport(1440);
    const { container } = render(<SplitConsole {...props} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('flex-col');
    expect(root.className).toContain('lg:flex-row');
    const graphPanel = screen.getByTestId('dag').parentElement?.parentElement as HTMLElement;
    for (const cls of ['lg:h-[46%]', 'lg:max-h-[380px]', 'lg:min-h-[200px]']) {
      expect(graphPanel.className).toContain(cls);
    }
  });
});

describe('Transcript layout', () => {
  it('puts the details between the step strip and the narrative on a phone', () => {
    mockViewport(500);
    render(<Transcript {...props} />);
    const rail = screen.getByTestId('rail');
    expect(rail.dataset.collapsible).toBe('true');
    expect(before(screen.getByText('Steps'), rail)).toBe(true);
    expect(before(rail, screen.getByText('Run narrative'))).toBe(true);
  });

  it('keeps the spine, narrative, rail order at desktop width', () => {
    mockViewport(1280);
    render(<Transcript {...props} />);
    expect(before(screen.getByText('Run narrative'), screen.getByTestId('rail'))).toBe(true);
  });

  it('lays the step spine out as a horizontal strip below the breakpoint only', () => {
    mockViewport(500);
    render(<Transcript {...props} />);
    const spine = screen.getByRole('button', { name: /impl/ }).parentElement as HTMLElement;
    expect(spine.className).toContain('flex-row');
    expect(spine.className).toContain('lg:flex-col');
    expect(screen.getByRole('button', { name: /impl/ }).className).toContain('min-h-[44px]');
  });
});

describe('Timeline layout', () => {
  it('orders timing, topology, feed below lg with CSS order, leaving the DOM as at desktop', () => {
    mockViewport(500);
    render(<FlightRecorder {...props} />);
    const timing = screen.getByText('Step timing').parentElement as HTMLElement;
    const topology = screen.getByTestId('dag').parentElement as HTMLElement;
    const feed = screen.getByText('Event feed').parentElement?.parentElement as HTMLElement;
    expect(timing.className).toContain('max-lg:order-1');
    expect(topology.className).toContain('max-lg:order-2');
    expect(feed.className).toContain('max-lg:order-3');
  });

  it('keeps the topology to the right of the feed at desktop width', () => {
    mockViewport(1440);
    render(<FlightRecorder {...props} />);
    expect(before(screen.getByText('Event feed'), screen.getByTestId('dag'))).toBe(true);
  });

  it('scrolls the waterfall sideways inside its own box instead of squeezing the bars', () => {
    mockViewport(500);
    render(<FlightRecorder {...props} />);
    const bars = screen.getByText('impl').closest('.min-w-\\[520px\\]') as HTMLElement;
    expect(bars).not.toBeNull();
    expect(bars.parentElement?.className).toContain('overflow-x-auto');
    // The step name stays pinned to the left edge while the bars scroll.
    expect(screen.getByText('impl').className).toContain('sticky');
  });

  it('makes the sideways scroller a keyboard-reachable region below lg, and a plain box above', () => {
    mockViewport(500);
    const { unmount } = render(<FlightRecorder {...props} />);
    const narrowBox = screen.getByText('impl').closest('.overflow-x-auto') as HTMLElement;
    expect(narrowBox.getAttribute('role')).toBe('region');
    expect(narrowBox.getAttribute('aria-label')).toBeTruthy();
    expect(narrowBox.tabIndex).toBe(0);
    unmount();
    mockViewport(1440);
    render(<FlightRecorder {...props} />);
    const wideBox = screen.getByText('impl').closest('.overflow-x-auto') as HTMLElement;
    expect(wideBox.getAttribute('role')).toBeNull();
    expect(wideBox.hasAttribute('tabindex')).toBe(false);
  });

  it('gives the play control and the position slider a touch-sized target', () => {
    mockViewport(500);
    render(<FlightRecorder {...props} />);
    expect(screen.getByRole('button', { name: /play replay/i }).className).toContain('h-[44px]');
    expect(screen.getByLabelText('Replay position').className).toContain('h-[40px]');
  });
});

describe('crossing the breakpoint keeps the tree', () => {
  it('keeps the graph and console of the Split layout mounted', () => {
    const viewport = mockViewport(1440);
    render(<SplitConsole {...props} />);
    const dag = screen.getByTestId('dag');
    const panel = screen.getByTestId('split-panel');
    act(() => viewport.setViewportWidth(500));
    expect(screen.getByTestId('dag')).toBe(dag);
    expect(screen.getByTestId('split-panel')).toBe(panel);
    act(() => viewport.setViewportWidth(1440));
    expect(screen.getByTestId('dag')).toBe(dag);
  });

  it('keeps the narrative of the Transcript layout mounted', () => {
    const viewport = mockViewport(1440);
    render(<Transcript {...props} />);
    const narrative = screen.getByText('Run narrative');
    act(() => viewport.setViewportWidth(500));
    expect(screen.getByText('Run narrative')).toBe(narrative);
  });

  it('keeps the topology graph and the feed of the Timeline layout mounted', () => {
    const viewport = mockViewport(1440);
    render(<FlightRecorder {...props} />);
    const dag = screen.getByTestId('dag');
    const feed = screen.getByText('Event feed');
    act(() => viewport.setViewportWidth(500));
    expect(screen.getByTestId('dag')).toBe(dag);
    expect(screen.getByText('Event feed')).toBe(feed);
    act(() => viewport.setViewportWidth(1440));
    expect(screen.getByTestId('dag')).toBe(dag);
  });
});

describe('scrubber step bands', () => {
  const late = {
    ...step,
    endedAt: null,
    id: 's-late',
    nodeId: 'late',
    startedAt: '2026-10-01T12:05:20Z',
    status: 'RUNNING' as const,
  };
  const lateRun = { ...run, steps: [step, late] } as unknown as WorkflowRunDetail;
  const bandLefts = () => {
    const track = screen.getByLabelText('Replay position');
    return Array.from(track.nextElementSibling?.children ?? []).map((band) =>
      Number.parseFloat((band as HTMLElement).style.left)
    );
  };

  it('stay inside the track below lg, so the scrolling page cannot overflow sideways', () => {
    mockViewport(500);
    render(<FlightRecorder {...props} run={lateRun} />);
    const widths = Array.from(
      screen.getByLabelText('Replay position').nextElementSibling?.children ?? []
    ).map((band) => Number.parseFloat((band as HTMLElement).style.width));
    const lefts = bandLefts();
    lefts.forEach((left, i) => {
      expect(left + widths[i]).toBeLessThanOrEqual(100);
    });
  });

  it('keep their original, overhanging geometry at desktop width', () => {
    mockViewport(1440);
    render(<FlightRecorder {...props} run={lateRun} />);
    expect(Math.max(...bandLefts())).toBeGreaterThan(100);
  });
});
