// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const create = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('@/hooks/useCampaigns', () => ({
  useCreateCampaign: () => ({ ...create, isPending: false }),
}));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => false }));
vi.mock('@/hooks/useTeams', () => ({
  useAuthoringTeams: () => ({
    global: false,
    isLoading: false,
    teams: [{ id: 't1', name: 'Payments', orgId: 'o1', orgName: 'Acme' }],
  }),
  useLedTeamIds: () => new Set(['t1']),
}));
vi.mock('@/hooks/useRepositories', () => ({
  useRepositories: () => ({
    data: [
      {
        id: 'r1',
        isActive: true,
        organizationName: 'acme',
        repoName: 'api',
        team: { id: 't1' },
        type: 'git_repo',
      },
      {
        id: 'r2',
        isActive: true,
        organizationName: 'acme',
        repoName: 'other-team',
        team: { id: 't2' },
        type: 'git_repo',
      },
    ],
  }),
}));

import { CampaignStartModal } from './CampaignStartModal';

beforeEach(() => stubDialogPrototype());
afterEach(() => {
  cleanup();
  create.mutateAsync.mockReset();
});

function fill() {
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Raise lodash' } });
  fireEvent.change(screen.getByLabelText(/^Brief/), {
    target: { value: 'Raise lodash to 4.17.21' },
  });
}

describe('CampaignStartModal', () => {
  it('lists only repositories of teams the caller leads', () => {
    render(<CampaignStartModal onClose={vi.fn()} onStarted={vi.fn()} open />);
    expect(screen.getByText('acme/api')).toBeTruthy();
    expect(screen.queryByText('acme/other-team')).toBeNull();
  });

  it('refuses to start without a repository', async () => {
    render(<CampaignStartModal onClose={vi.fn()} onStarted={vi.fn()} open />);
    fill();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    });
    expect(screen.getByText('Pick at least one repository.')).toBeTruthy();
    expect(create.mutateAsync).not.toHaveBeenCalled();
  });

  it('launches with the chosen repository and goes to the campaign', async () => {
    create.mutateAsync.mockResolvedValue({ campaignId: 'c1', detailPath: '/campaigns/c1' });
    const onStarted = vi.fn();
    render(<CampaignStartModal onClose={vi.fn()} onStarted={onStarted} open />);
    fill();
    fireEvent.click(screen.getByLabelText('acme/api'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    });
    expect(create.mutateAsync).toHaveBeenCalledWith({
      description: 'Raise lodash to 4.17.21',
      name: 'Raise lodash',
      ownerTeamId: 't1',
      repoIds: ['r1'],
    });
    expect(onStarted).toHaveBeenCalledWith('/campaigns/c1');
  });

  it('shows the gateway’s refusal in the form', async () => {
    create.mutateAsync.mockRejectedValue(new Error('Campaigns are not enabled'));
    render(<CampaignStartModal onClose={vi.fn()} onStarted={vi.fn()} open />);
    fill();
    fireEvent.click(screen.getByLabelText('acme/api'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    });
    expect(screen.getByText('Campaigns are not enabled')).toBeTruthy();
  });
});
