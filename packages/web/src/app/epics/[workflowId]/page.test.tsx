// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQuery } from '@/test/rtl-helpers';

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
const useEpic = vi.fn();
vi.mock('@/hooks/useEpics', () => ({ useEpic: (...args: unknown[]) => useEpic(...args) }));
vi.mock('@/hooks/useRuns', () => ({
  useRunsForWorkRequest: () => ({ data: [], isSuccess: true }),
}));

import EpicDetailPage from './page';

const EPIC = {
  children: [
    {
      branch: null,
      organizationName: 'acme',
      repoId: 'r1',
      repoName: 'api',
      status: 'SUCCESS',
      temporalWorkflowId: 'epic-1-r1',
      workflowId: 'w1',
    },
    {
      branch: null,
      organizationName: 'acme',
      repoId: 'r2',
      repoName: 'web',
      status: 'RUNNING',
      temporalWorkflowId: 'epic-1-r2',
      workflowId: 'w2',
    },
  ],
  createdAt: null,
  description: 'Migrate auth',
  epicWorkflowId: 'epic-1',
  externalTicketId: 'EPIC-1',
  requestedBy: null,
  status: 'RUNNING',
  updatedAt: null,
  workRequestId: null,
};

// One promise for the whole file: `use()` suspends on a new promise every render.
const PARAMS = Promise.resolve({ workflowId: 'epic-1' });

async function renderPage() {
  // `use()` suspends until the params promise settles; act lets that settle before assertions.
  await act(async () => {
    render(
      withQuery(
        <Suspense fallback={null}>
          <EpicDetailPage params={PARAMS} />
        </Suspense>
      )
    );
  });
}

afterEach(() => {
  cleanup();
  useEpic.mockReset();
});

describe('Epic detail page', () => {
  it('shows how many children have finished as a labelled meter', async () => {
    useEpic.mockReturnValue({ data: EPIC, error: null, isLoading: false, refetch: vi.fn() });
    await renderPage();
    const meter = await screen.findByRole('progressbar', { name: 'Child runs finished' });
    expect(meter.getAttribute('aria-valuenow')).toBe('1');
    expect(meter.getAttribute('aria-valuemax')).toBe('2');
    expect(screen.getByText('1 of 2 finished')).toBeTruthy();
  });

  it('offers a retry when the epic fails to load, and retries it', async () => {
    const refetch = vi.fn();
    useEpic.mockReturnValue({
      data: undefined,
      error: new Error('gateway down'),
      isLoading: false,
      refetch,
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
