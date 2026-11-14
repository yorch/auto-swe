// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { stubDialogPrototype, withQuery } from '@/test/rtl-helpers';

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
const useCampaign = vi.fn();
const cancel = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('@/hooks/useCampaigns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useCampaigns')>()),
  useCampaign: (...args: unknown[]) => useCampaign(...args),
  useCancelCampaign: () => ({ ...cancel, isPending: false }),
}));
vi.mock('@/hooks/useRuns', () => ({
  useRunsForWorkRequest: () => ({
    data: [{ id: 'run-1', workflowId: 'campaign-c1-conn-1' }],
    isSuccess: true,
  }),
}));
vi.mock('@/hooks/useWorkViews', () => ({
  usePullRequests: () => ({ data: [{ id: 'pr-9', repository: { id: 'conn-1' } }] }),
}));
const auth = vi.hoisted(() => ({
  led: new Set<string>(),
  user: { role: 'LEAD', sub: 'someone-else' } as { role: string; sub: string },
}));
vi.mock('@/hooks/useTeams', () => ({ useLedTeamIds: () => auth.led }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (select: (s: { user: typeof auth.user }) => unknown) => select({ user: auth.user }),
}));

import CampaignDetailPage from './page';

const CAMPAIGN = {
  cancelledAt: null,
  cancelledById: null,
  completedAt: null,
  counts: {
    CANCELLED: 0,
    FAILED: 1,
    NOT_AFFECTED: 0,
    PENDING: 0,
    PR_OPENED: 1,
    RUNNING: 0,
    SKIPPED: 0,
  },
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: { id: 'creator', name: 'Ada' },
  description: 'Raise lodash everywhere',
  hiddenTargetCount: 2,
  id: 'c1',
  maxParallel: 3,
  name: 'Raise lodash',
  orgId: 'o1',
  ownerTeam: { id: 't1', name: 'Payments' },
  recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
  recipeRef: 'npm-dependency@1',
  state: 'RUNNING',
  targets: [
    {
      childWorkflowId: 'campaign-c1-conn-1',
      connectionId: 'conn-1',
      failureReason: null,
      finishedAt: null,
      liveStatus: null,
      path: 'RECIPE',
      position: 0,
      prNumber: 12,
      prUrl: 'https://github.com/acme/api/pull/12',
      repoLabel: 'acme/api',
      startedAt: null,
      state: 'PR_OPENED',
      verification: 'PASSED',
    },
    {
      childWorkflowId: 'campaign-c1-conn-2',
      connectionId: 'conn-2',
      failureReason: 'tests failed',
      finishedAt: null,
      liveStatus: null,
      path: 'AGENT',
      position: 1,
      prNumber: null,
      prUrl: null,
      repoLabel: 'acme/web',
      startedAt: null,
      state: 'FAILED',
      verification: 'FAILED',
    },
  ],
  templateId: 'tpl',
  templateVersion: 1,
  temporalWorkflowId: 'campaign-c1',
  updatedAt: '2026-01-01T00:00:00Z',
  workRequestId: 'wr1',
};

const PARAMS = Promise.resolve({ id: '0b1c2d3e-0000-4000-8000-000000000001' });

async function renderPage() {
  await act(async () => {
    render(
      withQuery(
        <Suspense fallback={null}>
          <CampaignDetailPage params={PARAMS} />
        </Suspense>
      )
    );
  });
}

afterEach(() => {
  cleanup();
  useCampaign.mockReset();
  cancel.mutateAsync.mockReset();
  auth.led = new Set();
  auth.user = { role: 'LEAD', sub: 'someone-else' };
});

describe('Campaign detail page', () => {
  it('links each repository to its run and its draft to the review page', async () => {
    useCampaign.mockReturnValue({
      data: CAMPAIGN,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    await renderPage();
    expect(screen.getByRole('link', { name: 'acme/api' }).getAttribute('href')).toBe('/runs/run-1');
    expect(screen.getByRole('link', { name: '#12' }).getAttribute('href')).toBe(
      '/pull-requests/pr-9'
    );
    // No run is visible for the second repository, so it is plain text.
    expect(screen.queryByRole('link', { name: 'acme/web' })).toBeNull();
    expect(screen.getByText('tests failed')).toBeTruthy();
    const meter = screen.getByRole('progressbar', { name: 'Repositories finished' });
    expect(meter.getAttribute('aria-valuenow')).toBe('2');
    expect(screen.getByTestId('campaign-hidden-targets').textContent).toMatch(/2 repositories/);
  });

  it('hides cancel from someone who may not cancel', async () => {
    useCampaign.mockReturnValue({
      data: CAMPAIGN,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Cancel campaign' })).toBeNull();
  });

  it('lets the creator cancel after confirming', async () => {
    stubDialogPrototype();
    auth.user = { role: 'ENGINEER', sub: 'creator' };
    cancel.mutateAsync.mockResolvedValue({});
    useCampaign.mockReturnValue({
      data: CAMPAIGN,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel campaign' }));
    expect(cancel.mutateAsync).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Cancel campaign' }).at(-1) as Element);
    });
    expect(cancel.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('offers no cancel once the campaign is final', async () => {
    auth.user = { role: 'ADMIN', sub: 'admin' };
    useCampaign.mockReturnValue({
      data: { ...CAMPAIGN, state: 'COMPLETED' },
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    await renderPage();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('says not found for a campaign the gateway does not show', async () => {
    useCampaign.mockReturnValue({
      data: undefined,
      error: new ApiError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND'),
      isLoading: false,
      refetch: vi.fn(),
    });
    await renderPage();
    expect(screen.getByText('Campaign not found')).toBeTruthy();
  });

  it('offers a retry when the campaign fails to load', async () => {
    const refetch = vi.fn();
    useCampaign.mockReturnValue({
      data: undefined,
      error: new Error('gateway down'),
      isLoading: false,
      refetch,
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
