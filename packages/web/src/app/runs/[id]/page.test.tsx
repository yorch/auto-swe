// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQuery } from '@/test/rtl-helpers';

const state = vi.hoisted(() => ({ layout: 'A' as 'A' | 'B' | 'C' }));
const run = {
  contextSnapshot: {},
  costUsdAccrued: 0,
  endedAt: '2026-10-01T12:05:00Z',
  id: 'run-1',
  result: null,
  specSnapshot: {},
  startedAt: '2026-10-01T12:00:00Z',
  status: 'FAILED',
  steps: [
    {
      attempt: 1,
      endedAt: '2026-10-01T12:04:00Z',
      error: 'Tests would not pass',
      id: 's1',
      nodeId: 'build',
      startedAt: '2026-10-01T12:01:00Z',
      status: 'FAILED',
    },
  ],
  templateId: 't1',
  templateName: 'Fix flaky tests',
  templateVersion: 2,
  tokensInputTotal: 0,
  tokensOutputTotal: 0,
  traces: [],
  workflowId: 'wf-1',
  workRequest: { description: 'Fix it', externalTicketId: 'T-1', id: 'wr-1' },
};
const approval = {
  id: 'h1',
  kind: 'APPROVAL',
  nodeId: 'gate',
  requestedAt: '2026-10-01T12:02:00Z',
  run: { id: 'run-1', status: 'RUNNING', workflowId: 'wf-1' },
  runId: '11111111-1111-4111-8111-111111111111',
  status: 'PENDING',
  title: 'Approve the plan',
};
const idle = { isPending: false, isSuccess: false, mutate: vi.fn(), reset: vi.fn() };

vi.mock('@auto-swe/shared/workflow', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseWorkflowSpec: () => ({ edges: [], nodes: [] }),
}));
vi.mock('@/hooks/useRuns', () => ({
  useCancelWorkflowRun: () => idle,
  useRetriedRun: () => ({ runId: null, timedOut: false }),
  useRunDetail: () => ({
    data: run,
    error: null,
    fullTraces: false,
    fullTracesFailed: false,
    isError: false,
    isLoading: false,
    isPlaceholderData: false,
    toggleFullTraces: vi.fn(),
  }),
}));
vi.mock('@/hooks/useApprovals', () => ({ useApprovals: () => ({ data: [approval] }) }));
vi.mock('@/hooks/useRunReRun', () => ({
  useRunReRun: () => ({
    cancel: vi.fn(),
    confirm: vi.fn(),
    confirming: false,
    confirmMessage: null,
    data: undefined,
    errorView: null,
    isAgentRun: false,
    isPending: false,
    isSuccess: false,
    locked: false,
    request: vi.fn(),
  }),
}));
vi.mock('@/hooks/useUserPreferences', () => ({
  useUserPreferences: () => ({ layout: state.layout, setLayout: vi.fn() }),
}));
vi.mock('@/components/approvals/HumanStepCard', () => ({
  HumanStepCard: ({ step }: { step: { title: string } }) => <div>{step.title}</div>,
}));
vi.mock('@/components/workflow/WorkflowDag', () => ({ WorkflowDag: () => <div>diagram</div> }));
vi.mock('@/components/runs/RunMetaRail', () => ({ RunMetaRail: () => null }));
vi.mock('@/components/runs/TracesTab', () => ({ TracesTab: () => null }));
vi.mock('@/components/runs/SplitRunPanel', () => ({ SplitRunPanel: () => null }));

import RunDetailPage from './page';

const params = Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' });
async function renderPage() {
  await act(async () => {
    render(
      withQuery(
        <Suspense>
          <RunDetailPage params={params} />
        </Suspense>
      )
    );
  });
}
afterEach(cleanup);

describe('run page summary band', () => {
  it.each(['A', 'B', 'C'] as const)(
    'shows approvals and the failure in layout %s',
    async (layout) => {
      state.layout = layout;
      await renderPage();
      expect(screen.getByText('Approve the plan')).toBeTruthy();
      expect(screen.getAllByText(/Tests would not pass/).length).toBeGreaterThan(0);
    }
  );

  it('Jump to failure selects the failed step in the transcript layout', async () => {
    state.layout = 'B';
    await renderPage();
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    fireEvent.click(screen.getByRole('button', { name: /jump to failure/i }));
    expect(scrolled).toHaveBeenCalled();
  });
});
