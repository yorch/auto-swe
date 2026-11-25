// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const teamParam = vi.hoisted(() => ({
  value: {
    blocked: false,
    clear: vi.fn(),
    isError: false,
    pending: false,
    retry: vi.fn(),
    slug: '',
    team: null as { name: string } | null,
    teamId: undefined as string | undefined,
  },
}));
vi.mock('@/hooks/useTeamParam', () => ({ useTeamParam: () => teamParam.value }));

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('next/navigation', () => ({
  usePathname: () => '/campaigns',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const useCampaigns = vi.fn();
vi.mock('@/hooks/useCampaigns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useCampaigns')>()),
  useCampaigns: (...args: unknown[]) => useCampaigns(...args),
}));
// `canStart`: the caller leads a team, or is a platform ADMIN (the hook answers for both).
const role = vi.hoisted(() => ({ canStart: true }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => role.canStart }));
vi.mock('@/components/campaigns/CampaignStartModal', () => ({
  CampaignStartModal: ({ open }: { open: boolean }) => (open ? <div>start form</div> : null),
}));

import CampaignsPage from './page';

const settled = {
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  refetch: vi.fn(),
};
const ROW = {
  completedAt: null,
  counts: {
    blocked: 0,
    cancelled: 0,
    merged: 0,
    needsAttention: 1,
    pending: 1,
    prOpened: 2,
    running: 0,
    satisfied: 3,
    skipped: 0,
    total: 7,
  },
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: { id: 'u1', name: 'Ada' },
  createdById: 'u1',
  description: 'Raise lodash',
  expiresAt: null,
  gate: 'OPENED',
  id: 'c1',
  launchedById: 'u1',
  name: 'Raise lodash',
  ownerTeam: { id: 't1', name: 'Payments' },
  ownerTeamId: 't1',
  pausedReason: null,
  plan: 'UNIFORM',
  recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
  recipeRef: 'npm-dependency@2',
  state: 'ACTIVE',
  updatedAt: '2026-01-01T00:00:00Z',
  workflowKind: 'RECONCILER',
};

afterEach(() => {
  cleanup();
  useCampaigns.mockReset();
  nav.search = '';
  role.canStart = true;
});

describe('Campaigns page', () => {
  it('lists campaigns with satisfied-over-total progress and a count that needs attention', () => {
    useCampaigns.mockReturnValue({ ...settled, data: { data: [ROW], meta: { total: 1 } } });
    render(<CampaignsPage />);
    const link = screen.getByRole('link', { name: 'Raise lodash' });
    expect(link.getAttribute('href')).toBe('/campaigns/c1');
    expect(screen.getByText('3 of 7 satisfied')).toBeTruthy();
    expect(screen.getByText('1 needs attention')).toBeTruthy();
    expect(screen.getByText('2 in review · 1 not started')).toBeTruthy();
    expect(screen.getByText('lodash → 4.17.21 (npm-dependency@2)')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('shows the reason a campaign is paused and omits the attention line when nobody is needed', () => {
    useCampaigns.mockReturnValue({
      ...settled,
      data: {
        data: [
          {
            ...ROW,
            counts: { ...ROW.counts, needsAttention: 0 },
            pausedReason: 'budget',
            state: 'PAUSED',
          },
        ],
        meta: { total: 1 },
      },
    });
    render(<CampaignsPage />);
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText('budget reached')).toBeTruthy();
    expect(screen.queryByText(/need.* attention/)).toBeNull();
  });

  it('still renders a legacy campaign, whose counts were folded by the gateway', () => {
    useCampaigns.mockReturnValue({
      ...settled,
      data: {
        data: [
          {
            ...ROW,
            counts: {
              ...ROW.counts,
              needsAttention: 1,
              pending: 0,
              prOpened: 4,
              satisfied: 2,
              total: 7,
            },
            state: 'COMPLETED_WITH_FAILURES',
            workflowKind: 'LEGACY',
          },
        ],
        meta: { total: 1 },
      },
    });
    render(<CampaignsPage />);
    expect(screen.getByText('Completed with failures')).toBeTruthy();
    expect(screen.getByText('2 of 7 satisfied')).toBeTruthy();
  });

  it('asks for one page at a time, filtered from the address', () => {
    nav.search = 'state=RUNNING&offset=30';
    useCampaigns.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<CampaignsPage />);
    expect(useCampaigns).toHaveBeenCalledWith(
      { limit: 30, offset: 30, state: 'RUNNING' },
      expect.anything()
    );
  });

  it('filters by the new states and by kind', () => {
    nav.search = 'state=NEEDS_ATTENTION&plan=PLANNED';
    useCampaigns.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<CampaignsPage />);
    // NEEDS_ATTENTION is not a campaign state: it is dropped, PLANNED is kept.
    expect(useCampaigns).toHaveBeenCalledWith(
      { limit: 30, offset: 0, plan: 'PLANNED', state: undefined },
      expect.anything()
    );
    cleanup();
    nav.search = 'state=MONITORING';
    render(<CampaignsPage />);
    expect(useCampaigns).toHaveBeenLastCalledWith(
      { limit: 30, offset: 0, plan: undefined, state: 'MONITORING' },
      expect.anything()
    );
  });

  it('offers every campaign state in the state filter, named in words', () => {
    useCampaigns.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<CampaignsPage />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    const names = screen.getAllByRole('option').map((o) => o.textContent?.replace('✓', ''));
    expect(names).toEqual(
      expect.arrayContaining([
        'All states',
        'awaiting confirmation',
        'active',
        'paused',
        'monitoring',
        'completed with failures',
        'running',
      ])
    );
  });

  it('opens the start form for a lead', () => {
    stubDialogPrototype();
    useCampaigns.mockReturnValue({ ...settled, data: { data: [ROW], meta: { total: 1 } } });
    render(<CampaignsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Start a campaign/ }));
    expect(screen.getByText('start form')).toBeTruthy();
  });

  it('offers no way to start one to someone who is not a lead', () => {
    role.canStart = false;
    useCampaigns.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<CampaignsPage />);
    expect(screen.queryByRole('button', { name: /Start a campaign/ })).toBeNull();
    expect(
      screen.getByText(
        /Only a lead or admin of the team that owns the repositories, or a platform admin can start one/
      )
    ).toBeTruthy();
  });
});
