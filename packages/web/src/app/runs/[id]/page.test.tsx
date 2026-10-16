// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQuery } from '@/test/rtl-helpers';

const state = vi.hoisted(() => ({ layout: 'A' as 'A' | 'B' | 'C' }));
const run = {
  agentRuntimes: undefined as Record<string, string> | undefined,
  contextSnapshot: {},
  costUsdAccrued: 0,
  endedAt: '2026-10-01T12:05:00Z',
  id: 'run-1',
  implementerRuntime: null as string | null,
  result: null as unknown,
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
const answered = {
  ...approval,
  id: 'h2',
  responses: [
    { action: 'approve', byName: 'Dana', comment: 'Ship it', resolvedAt: null, value: null },
  ],
  status: 'APPROVED',
  title: 'Approved the design',
};
const idle = { isPending: false, isSuccess: false, mutate: vi.fn(), reset: vi.fn() };

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
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
vi.mock('@/hooks/useApprovals', () => ({ useApprovals: () => ({ data: [approval, answered] }) }));
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

describe('run page header', () => {
  afterEach(() => {
    run.implementerRuntime = null;
    run.agentRuntimes = undefined;
  });

  it('names what each agent ran on over the run-wide default', async () => {
    state.layout = 'A';
    run.implementerRuntime = 'mastra';
    run.agentRuntimes = { implementer: 'claude-code' };
    await renderPage();
    const badge = screen.getByText('Claude Code harness');
    expect(badge.closest('[title]')?.getAttribute('title')).toBe(
      'Runtime pinned for each agent with its own: implementer — Claude Code harness'
    );
    expect(screen.queryByText('Mastra loop')).toBeNull();
  });

  it('names both runtimes when agents ran on different ones', async () => {
    state.layout = 'A';
    run.agentRuntimes = { ciFixer: 'mastra', implementer: 'claude-code' };
    await renderPage();
    expect(screen.getByText('Claude Code harness + Mastra loop')).toBeTruthy();
  });

  it('names the implementer runtime the run pinned', async () => {
    state.layout = 'A';
    run.implementerRuntime = 'claude-code';
    await renderPage();
    expect(screen.getByText('Claude Code harness')).toBeTruthy();
  });

  it('shows no runtime badge when the run pinned none', async () => {
    state.layout = 'A';
    await renderPage();
    expect(screen.queryByText('Claude Code harness')).toBeNull();
    expect(screen.queryByText('Mastra loop')).toBeNull();
  });
});

describe('run page summary band', () => {
  it.each(['A', 'B', 'C'] as const)(
    'shows approvals and the failure in layout %s',
    async (layout) => {
      state.layout = layout;
      await renderPage();
      expect(screen.getByText('Approve the plan')).toBeTruthy();
      expect(screen.getByText('Approved the design')).toBeTruthy();
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

  it('describes Cancel and Re-run to assistive tech as well as on hover', async () => {
    state.layout = 'A';
    await renderPage();
    const rerun = screen
      .getAllByRole('button', { name: /Re-run/ })
      .find((button) => button.hasAttribute('aria-describedby')) as HTMLElement;
    expect(rerun.getAttribute('title')).toMatch(/new run of the same request/);
    expect(rerun.getAttribute('aria-describedby')).toBe('re-run-hint');
    expect(document.getElementById('re-run-hint')?.textContent).toMatch(/This run is kept/);
    expect(document.getElementById('cancel-run-hint')?.textContent).toMatch(/aborted/);
  });

  it('explains gates once on the page and keeps the lifecycle explainer in the Help panel', async () => {
    state.layout = 'A';
    await renderPage();
    expect(screen.getAllByRole('button', { name: /What is a gate/ })).toHaveLength(1);
    const help = screen.getByText('How auto-swe works').closest('[data-testid="page-help"]');
    expect(help).not.toBeNull();
    expect(screen.getByText('How auto-swe works').closest('details')).toBeNull();
  });

  it('puts the trace hint sentence in the Help panel, not under the title', async () => {
    state.layout = 'A';
    await renderPage();
    const hint = screen.getByText(/Below the header is the run's trace/);
    expect(hint.closest('[data-testid="page-help"]')).not.toBeNull();
  });
});

describe('run page verdict and reading guide', () => {
  afterEach(() => {
    run.status = 'FAILED';
    run.result = null;
  });

  it('states a failed run in plain language and points at the failed step', async () => {
    state.layout = 'A';
    await renderPage();
    expect(screen.getByText(/does not recognise this error/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Jump to the failed step' })).toBeTruthy();
  });

  it('says a finished run without a pull request has none', async () => {
    state.layout = 'A';
    run.status = 'SUCCESS';
    await renderPage();
    expect(screen.getByText('Finished')).toBeTruthy();
    expect(screen.getByText(/recorded no pull request link/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open the pull request' })).toBeNull();
  });

  it('links the pull request of a finished run', async () => {
    state.layout = 'A';
    run.status = 'SUCCESS';
    run.result = { prUrl: 'https://github.com/acme/api/pull/7' };
    await renderPage();
    const link = screen.getByRole('link', { name: 'Open the pull request' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/api/pull/7');
  });

  it('names the open gate while the run waits on a person', async () => {
    state.layout = 'A';
    run.status = 'RUNNING';
    await renderPage();
    expect(screen.getByText('Waiting on a person')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to the gate' }).getAttribute('href')).toBe(
      '#run-needs-response'
    );
    expect(document.getElementById('run-needs-response')).not.toBeNull();
  });

  it('offers the reading guide in the Help panel, distinct from the lifecycle explainer', async () => {
    state.layout = 'A';
    await renderPage();
    const guide = screen.getByText('How to read this page').closest('section');
    expect(guide).not.toBeNull();
    expect(guide?.closest('[data-testid="page-help"]')).not.toBeNull();
    for (const name of ['Split', 'Transcript', 'Timeline']) {
      expect(guide?.textContent).toContain(name);
    }
    expect(guide).not.toBe(screen.getByText('How auto-swe works').closest('section'));
  });
});
