// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { TeamManagePanel } from './TeamManagePanel';

vi.mock('@/components/teams/ServicePrincipalsSection', () => ({
  ServicePrincipalsSection: ({ repositories }: { repositories: { label: string }[] }) => (
    <div data-testid="service-principals">{repositories.map((r) => r.label).join(',')}</div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TEAM_ID = '11111111-1111-4111-8111-111111111111';

const team = {
  _count: { memberships: 3, repositories: 2 },
  defaultPersonaPrompt: null,
  description: '',
  id: TEAM_ID,
  myRole: 'LEAD' as const,
  name: 'Payments',
  orgId: 'org-1',
  orgName: 'Acme',
  slug: 'payments',
};

function gateway() {
  setupFetchMock({
    'GET /api/v1/automations': () => ({ data: [] }),
    'GET /api/v1/scheduled-work-requests': () => ({ data: [] }),
    [`GET /api/v1/teams/${TEAM_ID}`]: () => ({
      data: {
        id: TEAM_ID,
        repositories: [
          { id: 'r1', isActive: true, organizationName: 'acme', repoName: 'api' },
          { id: 'r2', isActive: false, organizationName: 'acme', repoName: 'old' },
        ],
        sharedRepositories: [
          {
            canLaunch: false,
            id: 'r3',
            isActive: true,
            organizationName: 'acme',
            repoName: 'lib',
            team: { id: 't2', name: 'Platform', slug: 'platform' },
          },
        ],
      },
    }),
    [`GET /api/v1/teams/${TEAM_ID}/overview`]: () => ({
      data: {
        budget: { percentUsed: 40, scope: 'team', state: 'ok' },
      },
    }),
  });
}

describe('TeamManagePanel', () => {
  it('shows Repositories, Schedules, Automations, Budget and Service principals to a lead', async () => {
    gateway();
    render(withQuery(<TeamManagePanel canManageBudget={false} team={team} />));
    for (const name of ['Repositories', 'Schedules', 'Automations', 'Budget']) {
      expect(await screen.findByRole('heading', { name })).toBeTruthy();
    }
    // Owned and shared repositories, with the view-only mark on a share that cannot launch.
    expect(await screen.findByText('acme/api')).toBeTruthy();
    expect(screen.getByText('acme/lib')).toBeTruthy();
    expect(screen.getByText('View only')).toBeTruthy();
    // Service principals (the section is mocked) take the active owned repositories and the shared ones.
    expect((await screen.findByTestId('service-principals')).textContent).toBe('acme/api,acme/lib');
  });

  it('links to the budget editor only for a caller who may edit the cap', async () => {
    gateway();
    render(withQuery(<TeamManagePanel canManageBudget team={team} />));
    const budget = await screen.findByTestId('manage-budget');
    expect(
      (await within(budget).findByRole('link', { name: /budget/i })).getAttribute('href')
    ).toBe('/teams/payments/settings?tab=budget');
    expect(within(budget).queryByText('Ask a team or organization admin to change it.')).toBeNull();
  });

  it('shows a lead who cannot edit the cap the meter and who to ask', async () => {
    gateway();
    render(withQuery(<TeamManagePanel canManageBudget={false} team={team} />));
    const budget = await screen.findByTestId('manage-budget');
    expect(
      await within(budget).findByText('Ask a team or organization admin to change it.')
    ).toBeTruthy();
    expect(within(budget).queryByRole('link')).toBeNull();
    expect(within(budget).getByRole('progressbar')).toBeTruthy();
  });
});
