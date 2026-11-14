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
const role = vi.hoisted(() => ({ canStart: true }));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => role.canStart }));
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
    CANCELLED: 0,
    FAILED: 1,
    NOT_AFFECTED: 0,
    PENDING: 1,
    PR_OPENED: 2,
    RUNNING: 0,
    SKIPPED: 0,
  },
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: { id: 'u1', name: 'Ada' },
  id: 'c1',
  name: 'Raise lodash',
  ownerTeam: { id: 't1', name: 'Payments' },
  recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
  recipeRef: 'npm-dependency@1',
  state: 'RUNNING',
};

afterEach(() => {
  cleanup();
  useCampaigns.mockReset();
  nav.search = '';
  role.canStart = true;
});

describe('Campaigns page', () => {
  it('lists campaigns with progress and links each to its page', () => {
    useCampaigns.mockReturnValue({ ...settled, data: { data: [ROW], meta: { total: 1 } } });
    render(<CampaignsPage />);
    const link = screen.getByRole('link', { name: 'Raise lodash' });
    expect(link.getAttribute('href')).toBe('/campaigns/c1');
    expect(screen.getByText('3 of 4 done')).toBeTruthy();
    expect(screen.getByText('1 pending · 2 draft PRs · 1 failed')).toBeTruthy();
    expect(screen.getByText('lodash → 4.17.21 (npm-dependency@1)')).toBeTruthy();
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
    expect(screen.getByText(/A team lead or administrator can start one/)).toBeTruthy();
  });
});
