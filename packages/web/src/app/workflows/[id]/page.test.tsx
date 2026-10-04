// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

import WorkflowDetailPage from './page';

const ID = '11111111-1111-4111-8111-111111111111';
const workflow = {
  assignedBranch: 'auto/JIRA-1',
  budgetTier: 'STANDARD',
  costUsdAccrued: 1.5,
  currentStatus: 'FAILED',
  id: ID,
  pullRequests: [{ ciStatus: null, id: 'pr', prNumber: 9, status: 'OPEN' }],
  repository: { githubUrl: null, id: 'r', organizationName: 'acme', repoName: 'api' },
  temporalWorkflowId: 'eng-acme-api-JIRA-1',
  tokensInputUsed: 0,
  tokensOutputUsed: 0,
  updatedAt: '2026-10-01T00:00:00Z',
};

const params = Promise.resolve({ id: ID });
async function renderPage() {
  await act(async () => {
    render(
      withQuery(
        <Suspense>
          <WorkflowDetailPage params={params} />
        </Suspense>
      )
    );
  });
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('workflow detail address', () => {
  it('forwards to the request panel when the workflow has a request', async () => {
    setupFetchMock({
      [`GET /api/v1/workflows/${ID}`]: () => ({
        data: {
          ...workflow,
          workRequest: { description: 'd', externalTicketId: 'T-1', id: 'wr-1' },
        },
      }),
    });
    await renderPage();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/workflows?request=wr-1'));
  });

  it('shows what is left, never "not found", when the request is gone', async () => {
    setupFetchMock({
      [`GET /api/v1/workflows/${ID}`]: () => ({ data: { ...workflow, workRequest: null } }),
    });
    await renderPage();
    expect(await screen.findByText('acme/api')).toBeTruthy();
    expect(screen.queryByText('Request not found')).toBeNull();
    expect(screen.getByText('auto/JIRA-1')).toBeTruthy();
    expect(screen.getByRole('link', { name: /View pull request/ }).getAttribute('href')).toBe(
      'https://github.com/acme/api/pull/9'
    );
    expect(replace).not.toHaveBeenCalled();
  });
});
