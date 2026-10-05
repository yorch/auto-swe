// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { RequestPanel } from './RequestPanel';

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
