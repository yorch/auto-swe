// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CampaignSummary } from '@/hooks/useCampaigns';

vi.mock('next/navigation', () => ({
  usePathname: () => '/campaigns',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { CampaignList } from './CampaignList';

afterEach(cleanup);

const ROW: CampaignSummary = {
  counts: {
    blocked: 0,
    cancelled: 0,
    merged: 0,
    needsAttention: 2,
    pending: 0,
    prOpened: 1,
    running: 0,
    satisfied: 5,
    skipped: 0,
    total: 8,
  },
  createdAt: '2026-01-01T00:00:00Z',
  createdById: 'u1',
  description: 'Raise lodash',
  expiresAt: null,
  gate: 'OPENED',
  id: 'c1',
  launchedById: 'u1',
  name: 'Raise lodash',
  ownerTeamId: 't1',
  pausedReason: null,
  plan: 'PLANNED',
  recipeRef: null,
  state: 'PLANNING',
  updatedAt: '2026-01-01T00:00:00Z',
  workflowKind: 'RECONCILER',
};

describe('CampaignList', () => {
  it('shows satisfied over total, the count that needs attention and the plan', () => {
    render(<CampaignList campaigns={[ROW]} />);
    expect(screen.getByText('5 of 8 done')).toBeTruthy();
    expect(screen.getByText('2 need attention')).toBeTruthy();
    expect(screen.getByText('1 in review')).toBeTruthy();
    expect(screen.getByText('Awaiting confirmation')).toBeTruthy();
    expect(screen.getByText(/Planned per repository · Agent only/)).toBeTruthy();
  });

  it('says satisfied when the campaign has a check', () => {
    render(<CampaignList campaigns={[{ ...ROW, recipeRef: 'npm-dependency@2' }]} />);
    expect(screen.getByText('5 of 8 satisfied')).toBeTruthy();
  });

  it('counts merged pull requests as done when the campaign has no check', () => {
    const row = { ...ROW, counts: { ...ROW.counts, merged: 2 }, recipeRef: null };
    render(<CampaignList campaigns={[row]} />);
    expect(screen.getByText('7 of 8 done')).toBeTruthy();
    expect(screen.queryByText(/merged, checking/)).toBeNull();
  });

  it('leaves out the team and starter columns when the gateway names neither', () => {
    render(<CampaignList campaigns={[ROW]} />);
    expect(screen.queryByRole('columnheader', { name: 'Team' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Started by' })).toBeNull();
    cleanup();
    render(
      <CampaignList
        campaigns={[
          {
            ...ROW,
            createdBy: { id: 'u1', name: 'Ada' },
            ownerTeam: { id: 't1', name: 'Payments' },
          },
        ]}
      />
    );
    expect(screen.getByRole('columnheader', { name: 'Team' })).toBeTruthy();
    expect(screen.getByText('Ada')).toBeTruthy();
  });
});
