// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const create = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('@/hooks/useCampaigns', () => ({
  useCreateCampaign: () => ({ ...create, isPending: false }),
}));
// The caller may start a campaign for team t1 only: the server's answer per team.
vi.mock('@/hooks/useCan', () => ({ useCanOnTeams: () => (teamId: string) => teamId === 't1' }));
vi.mock('@/hooks/useTeams', () => ({
  useAuthoringTeams: () => ({
    global: false,
    isLoading: false,
    teams: [{ id: 't1', name: 'Payments', orgId: 'o1', orgName: 'Acme' }],
  }),
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
      plan: 'UNIFORM',
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

  function pickRecipe(name: RegExp) {
    fireEvent.click(screen.getByRole('button', { name: /\sRecipe$/ }));
    fireEvent.click(screen.getByRole('option', { name }));
  }

  it('says that @2 recipes enable discovery and merge verification and @1 recipes do not', () => {
    render(<CampaignStartModal onClose={vi.fn()} onStarted={vi.fn()} open />);
    expect(
      screen.getByText(
        /Recipes ending @2 also enable discovery and verification of merges; @1 recipes do not/
      )
    ).toBeTruthy();
    expect(screen.queryByLabelText('Find more repositories in')).toBeNull();
    pickRecipe(/npm-dependency@2/);
    expect(screen.getByText(/the campaign can find repositories that start to match/)).toBeTruthy();
    expect(screen.getByLabelText(/Find more repositories in/)).toBeTruthy();
    expect(screen.getByLabelText(/Re-check every/)).toBeTruthy();
    pickRecipe(/go-module@1/);
    expect(
      screen.getByText(/no discovery of new repositories and no verification of merges/)
    ).toBeTruthy();
    expect(screen.queryByLabelText(/Find more repositories in/)).toBeNull();
    expect(screen.queryByLabelText(/Re-check every/)).toBeNull();
  });

  it('launches a recipe campaign with discovery, limits and a budget', async () => {
    create.mutateAsync.mockResolvedValue({ campaignId: 'c1', detailPath: '/campaigns/c1' });
    render(<CampaignStartModal onClose={vi.fn()} onStarted={vi.fn()} open />);
    fill();
    pickRecipe(/npm-dependency@2/);
    fireEvent.change(screen.getByLabelText(/^Package name/), { target: { value: 'lodash' } });
    fireEvent.change(screen.getByLabelText(/^Target version/), { target: { value: '4.17.21' } });
    fireEvent.click(screen.getByLabelText('acme/api'));
    fireEvent.click(screen.getByRole('button', { name: /\sFind more repositories in$/ }));
    fireEvent.click(screen.getByRole('option', { name: /owning team’s repositories/ }));
    fireEvent.change(screen.getByLabelText(/Open pull requests at most/), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText(/Stale after/), { target: { value: '14' } });
    fireEvent.change(screen.getByLabelText(/Re-check every/), { target: { value: '24' } });
    fireEvent.change(screen.getByLabelText(/Monthly budget/), { target: { value: '250.50' } });
    fireEvent.change(screen.getByLabelText(/Lifetime/), { target: { value: '90' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    });
    expect(create.mutateAsync).toHaveBeenCalledWith({
      budgetUsd: 250.5,
      description: 'Raise lodash to 4.17.21',
      lifetimeDays: 90,
      maxOpenPullRequests: 5,
      name: 'Raise lodash',
      ownerTeamId: 't1',
      plan: 'UNIFORM',
      recipe: {
        params: { packageName: 'lodash', targetVersion: '4.17.21' },
        ref: 'npm-dependency@2',
      },
      repoIds: ['r1'],
      rescanIntervalHours: 24,
      scope: { id: 't1', kind: 'TEAM' },
      staleAfterDays: 14,
    });
  });

  it('leaves discovery and the re-check interval out for a recipe that cannot check', async () => {
    create.mutateAsync.mockResolvedValue({ campaignId: 'c1' });
    render(<CampaignStartModal onClose={vi.fn()} onStarted={vi.fn()} open />);
    fill();
    pickRecipe(/npm-dependency@2/);
    fireEvent.click(screen.getByRole('button', { name: /\sFind more repositories in$/ }));
    fireEvent.click(screen.getByRole('option', { name: /whole organization/ }));
    fireEvent.change(screen.getByLabelText(/Re-check every/), { target: { value: '12' } });
    pickRecipe(/npm-dependency@1/);
    fireEvent.change(screen.getByLabelText(/^Package name/), { target: { value: 'lodash' } });
    fireEvent.change(screen.getByLabelText(/^Target version/), { target: { value: '4.17.21' } });
    fireEvent.click(screen.getByLabelText('acme/api'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    });
    const body = create.mutateAsync.mock.calls[0]?.[0];
    expect(body.scope).toBeUndefined();
    expect(body.rescanIntervalHours).toBeUndefined();
    expect(body.recipe.ref).toBe('npm-dependency@1');
  });

  it('plans per repository with the opened gate by default and says what the merged gate costs', async () => {
    create.mutateAsync.mockResolvedValue({ campaignId: 'c1' });
    render(<CampaignStartModal onClose={vi.fn()} onStarted={vi.fn()} open />);
    fill();
    expect(screen.queryByLabelText(/upstream draft pull request is open/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Planned per repository/));
    expect(
      (screen.getByLabelText(/upstream draft pull request is open/) as HTMLInputElement).checked
    ).toBe(true);
    expect(screen.getByText(/Slower: every step in a chain waits for review and CI/)).toBeTruthy();
    // A planned campaign takes its work from the planner: no recipe to pick.
    expect(screen.queryByRole('button', { name: /\sRecipe$/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('acme/api'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    });
    expect(create.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      gate: 'OPENED',
      plan: 'PLANNED',
    });
    expect(create.mutateAsync.mock.calls[0]?.[0].recipe).toBeUndefined();
  });

  it('opts in to the merged gate', async () => {
    create.mutateAsync.mockResolvedValue({ campaignId: 'c1' });
    render(<CampaignStartModal onClose={vi.fn()} onStarted={vi.fn()} open />);
    fill();
    fireEvent.click(screen.getByLabelText(/Planned per repository/));
    fireEvent.click(screen.getByLabelText(/upstream pull request has merged/));
    fireEvent.click(screen.getByLabelText('acme/api'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    });
    expect(create.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      gate: 'MERGED',
      plan: 'PLANNED',
    });
  });

  it('refuses an out-of-range limit before asking the gateway', async () => {
    render(<CampaignStartModal onClose={vi.fn()} onStarted={vi.fn()} open />);
    fill();
    fireEvent.click(screen.getByLabelText('acme/api'));
    fireEvent.change(screen.getByLabelText(/Stale after/), { target: { value: '400' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    });
    expect(screen.getByText('Stale after must be a whole number from 1 to 365.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Stale after/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Monthly budget/), { target: { value: '-3' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start campaign' }));
    });
    expect(screen.getByText(/Monthly budget must be an amount in dollars/)).toBeTruthy();
    expect(create.mutateAsync).not.toHaveBeenCalled();
  });
});
