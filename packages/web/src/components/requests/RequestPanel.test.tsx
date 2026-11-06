// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { RequestPanel, requestProgress } from './RequestPanel';

vi.mock('@/components/workflow/WorkflowDag', () => ({
  WorkflowDag: () => <div>Workflow diagram</div>,
}));
const REQUEST = '11111111-1111-4111-8111-111111111111';
const base = {
  contextSnapshot: {},
  humanSteps: [],
  result: null,
  specSnapshot: {},
  startedAt: '2026-10-01T12:00:00Z',
  steps: [],
  templateName: 'Custom',
  traces: [],
  workRequest: { description: 'Update dependencies', externalTicketId: 'DEP-1', id: REQUEST },
};
const success = {
  ...base,
  id: 'run-success',
  result: { prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7' },
  status: 'SUCCESS',
  steps: [
    { attempt: 1, error: 'An old failure', id: 'recovered', nodeId: 'build', status: 'FAILED' },
    { attempt: 2, id: 'passed', nodeId: 'build', status: 'PASSED' },
  ],
};
const failed = {
  ...base,
  id: 'run-failed',
  status: 'FAILED',
  steps: [
    {
      attempt: 1,
      error: 'CI failed on the old attempt',
      id: 'failure',
      nodeId: 'build',
      status: 'FAILED',
    },
  ],
};
function gateway() {
  return setupFetchMock({
    'GET /api/v1/human-steps': () => ({ data: [] }),
    'GET /api/v1/workflow-runs': () => ({
      data: [success, failed],
      meta: { limit: 20, offset: 0, total: 2 },
    }),
    'GET /api/v1/workflow-runs/requests': () => ({
      data: [],
      meta: { limit: 1, offset: 0, total: 0 },
    }),
    'GET /api/v1/workflow-runs/run-failed': () => ({ data: failed }),
    'GET /api/v1/workflow-runs/run-success': () => ({ data: success }),
  });
}
beforeEach(stubDialogPrototype);
afterEach(() => vi.unstubAllGlobals());

describe('request side panel', () => {
  it('waits for a queued review request without reading its reserved run, then shows the execution', async () => {
    let started = false;
    const fetch = setupFetchMock({
      'GET /api/v1/human-steps': () => ({ data: [] }),
      'GET /api/v1/workflow-runs': () => ({
        data: started ? [{ ...success, id: 'review-1' }] : [],
        meta: { limit: 20, offset: 0, total: started ? 1 : 0 },
      }),
      'GET /api/v1/workflow-runs/requests': () => ({ data: [], meta: { total: 0 } }),
      'GET /api/v1/workflow-runs/review-1': () => ({ data: { ...success, id: 'review-1' } }),
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <RequestPanel onClose={vi.fn()} requestId={REQUEST} />
      </QueryClientProvider>
    );
    await screen.findByText(/No visible attempts yet/);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/workflow-runs/review-1'))).toBe(
      false
    );
    expect(screen.queryByText(/Could not load/)).toBeNull();
    started = true;
    await act(async () => {
      await qc.invalidateQueries();
    });
    const link = await screen.findByRole('link', { name: /Open full diagnostics/ });
    expect(link.getAttribute('href')).toBe('/runs/review-1');
    expect(screen.queryByText(/No visible attempts yet/)).toBeNull();
  });

  it('leads with the latest result and does not resurrect a recovered step failure', async () => {
    const spy = gateway();
    render(withQuery(<RequestPanel onClose={vi.fn()} requestId={REQUEST} />));
    expect(await screen.findByText('Review PR #7')).toBeTruthy();
    expect(screen.queryByText('An old failure')).toBeNull();
    expect(screen.queryByText('CI failed on the old attempt')).toBeNull();
    const link = screen.getByRole('link', { name: /Open full diagnostics/ });
    expect(link.getAttribute('href')).toBe('/runs/run-success');
    const calls = spy.mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.includes('human-steps?runId=run-success'))).toBe(true);
    expect(calls.some((url) => url.includes('includeTraces=true'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Previous.*failed/i }));
    expect(await screen.findByText('CI failed on the old attempt')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry with instructions' })).toBeNull();
  });

  it('starts one retry with instructions and follows the returned execution', async () => {
    let retried = false;
    const next = { ...success, id: 'run-retry', workflowId: 'wf-retry' };
    const spy = setupFetchMock({
      'GET /api/v1/human-steps': () => ({ data: [] }),
      'GET /api/v1/workflow-runs': () => ({
        data: retried ? [next, failed] : [failed],
        meta: { total: retried ? 2 : 1 },
      }),
      'GET /api/v1/workflow-runs/requests': () => ({ data: [], meta: { total: 0 } }),
      'GET /api/v1/workflow-runs/run-failed': () => ({ data: failed }),
      'GET /api/v1/workflow-runs/run-retry': () => ({ data: next }),
      [`POST /api/v1/work-requests/${REQUEST}/retry`]: () => {
        retried = true;
        return {
          data: { temporalWorkflowId: 'wf-retry', workflowIds: ['ledger'], workRequestId: REQUEST },
        };
      },
    });
    render(withQuery(<RequestPanel onClose={vi.fn()} requestId={REQUEST} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry with instructions' }));
    fireEvent.change(screen.getByLabelText('Additional instructions'), {
      target: { value: 'Check CI before publishing' },
    });
    const launch = screen.getByRole('button', { name: 'Start attempt' });
    fireEvent.click(launch);
    fireEvent.click(launch);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Open full diagnostics/ }).getAttribute('href')).toBe(
        '/runs/run-retry'
      )
    );
    const writes = spy.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][1]?.body as string)).toEqual({
      instructions: 'Check CI before publishing',
    });
  });

  it('shows query failures instead of claiming a request has no attempts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 503 })
      )
    );
    render(withQuery(<RequestPanel onClose={vi.fn()} requestId={REQUEST} />));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Could not load request attempts')
    );
    expect(screen.queryByText(/No visible attempts yet/)).toBeNull();
  });
});

describe('requestProgress', () => {
  it('does not read a run that has done 2 of 12 steps as 2 of 2', () => {
    const p = requestProgress({ passed: 2, recorded: 2, running: true, specStepTotal: 12 });
    expect(p.label).toBe('2 steps completed, of up to 12.');
    expect(p.fraction).toBeCloseTo(2 / 12);
  });

  it('states only the count when the workflow total is unknown', () => {
    const p = requestProgress({ passed: 1, recorded: 1, running: true, specStepTotal: 0 });
    expect(p).toEqual({ fraction: 0, label: '1 step completed so far.' });
  });

  it('measures a finished run against the steps it recorded', () => {
    const p = requestProgress({ passed: 3, recorded: 4, running: false, specStepTotal: 12 });
    expect(p).toEqual({ fraction: 0.75, label: '3 of 4 steps passed.' });
  });
});

describe('request side panel naming', () => {
  it('names the dialog after the request once it has loaded', async () => {
    gateway();
    render(withQuery(<RequestPanel onClose={vi.fn()} requestId={REQUEST} />));
    await screen.findByText('Review PR #7');
    expect(document.querySelector('dialog')?.getAttribute('aria-label')).toBe(
      'Request: Update dependencies'
    );
  });
});
