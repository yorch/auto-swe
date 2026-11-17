// @vitest-environment jsdom
import type { TeamOverview } from '@auto-swe/shared/types/api';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamOverviewView } from './TeamOverviewView';

afterEach(cleanup);

const base: TeamOverview = {
  activity: [
    {
      launchedByName: 'Ada',
      occurredAt: '2026-11-08T10:00:00.000Z',
      repoName: 'acme/api',
      requestId: 'req-1',
      runId: 'run-1',
      state: 'failed',
      title: 'Fix the login bug',
    },
  ],
  budget: null,
  last7d: { failed: 1, started: 4, succeeded: 3 },
  mine: { failed: 0, prsAwaitingMerge: 0, running: 0 },
  needsYou: { total: 2 },
  pullRequests: {
    closedUnmerged: 1,
    merged: 5,
    mergeRate: 0.5,
    opened: 8,
    timeToMergeP50Hours: 6.4,
  },
  queued: 1,
  repos: [
    {
      canLaunch: true,
      id: 'r1',
      launchBudget: null,
      name: 'acme/api',
      ownerTeamName: null,
      relation: 'owned',
    },
    {
      canLaunch: false,
      id: 'r2',
      launchBudget: null,
      name: 'acme/shared-ui',
      ownerTeamName: 'Design',
      relation: 'shared',
    },
  ],
  running: 2,
  team: {
    id: 't1',
    myRole: 'ENGINEER',
    name: 'Payments',
    orgId: 'o1',
    orgName: 'Acme',
    slug: 'payments',
  },
  viewerLevel: 'engineer',
};

describe('TeamOverviewView', () => {
  it('shows needs-you, running and queued, 7-day success and PR outcomes', () => {
    render(<TeamOverviewView overview={base} slug="payments" />);
    const numbers = within(screen.getByLabelText('Team numbers'));
    expect(numbers.getByText('Needs you').parentElement?.textContent).toContain('2');
    expect(numbers.getByText('1 queued')).toBeTruthy();
    expect(numbers.getByText('75%')).toBeTruthy();
    expect(numbers.getByText('PRs merged').parentElement?.textContent).toContain('5');
    expect(numbers.getByText(/median 6 h to merge/)).toBeTruthy();
  });

  it('links Needs you to the steps the caller can answer, the set the number counts', () => {
    render(<TeamOverviewView overview={base} slug="payments" />);
    expect(screen.getByRole('link', { name: 'Open your steps' }).getAttribute('href')).toBe(
      '/approvals?team=payments&actionable=1'
    );
  });

  it('lists activity with a link to the request, and repos as owned or shared from a team', () => {
    render(<TeamOverviewView overview={base} slug="payments" />);
    expect(screen.getByRole('link', { name: 'Fix the login bug' }).getAttribute('href')).toBe(
      '/requests?request=req-1'
    );
    expect(screen.getByText('owned')).toBeTruthy();
    expect(screen.getByText('owned by Design')).toBeTruthy();
  });

  it('shows the budget meter in its full variant, and hides the panel without a budget', () => {
    const { rerender } = render(
      <TeamOverviewView
        overview={{
          ...base,
          budget: { alertThresholdPercent: 80, percentUsed: 85, scope: 'org', state: 'alert' },
        }}
        slug="payments"
      />
    );
    const panel = within(screen.getByTestId('budget-panel'));
    expect(panel.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('85');
    expect(panel.getByText('Alerts at 80%.')).toBeTruthy();
    rerender(<TeamOverviewView overview={base} slug="payments" />);
    expect(screen.queryByTestId('budget-panel')).toBeNull();
  });

  it('renders no lead or admin panel when the server sent none', () => {
    render(<TeamOverviewView overview={base} slug="payments" />);
    expect(screen.queryByTestId('lead-panel')).toBeNull();
    expect(screen.queryByTestId('admin-panel')).toBeNull();
    expect(screen.queryByText('Team attention')).toBeNull();
    expect(screen.queryByText('Spend this month')).toBeNull();
  });

  it('renders the lead panel when present, and no cost panel without it', () => {
    render(
      <TeamOverviewView
        overview={{
          ...base,
          lead: { openPullRequests: 4, staleApprovals: 2, unownedFailures: 3 },
          viewerLevel: 'lead',
        }}
        slug="payments"
      />
    );
    const lead = within(screen.getByTestId('lead-panel'));
    expect(lead.getByText('Failures with no owner').nextElementSibling?.textContent).toBe('3');
    expect(lead.getByText('Stale approvals').nextElementSibling?.textContent).toBe('2');
    expect(lead.getByText('Open pull requests').nextElementSibling?.textContent).toBe('4');
    expect(screen.queryByTestId('admin-panel')).toBeNull();
  });

  it('renders the cost when present, and says so when it cannot be computed', () => {
    const { rerender } = render(
      <TeamOverviewView
        overview={{
          ...base,
          admin: { monthCostUsdCents: 123456 },
          lead: { openPullRequests: 0, staleApprovals: 0, unownedFailures: 0 },
          viewerLevel: 'admin',
        }}
        slug="payments"
      />
    );
    expect(within(screen.getByTestId('admin-panel')).getByText('$1,234.56')).toBeTruthy();
    rerender(
      <TeamOverviewView
        overview={{ ...base, admin: { monthCostUsdCents: null }, viewerLevel: 'admin' }}
        slug="payments"
      />
    );
    expect(within(screen.getByTestId('admin-panel')).getByText('Not available')).toBeTruthy();
  });

  it('says the dollars are for organization admins when the server left the spend out', () => {
    render(
      <TeamOverviewView overview={{ ...base, admin: {}, viewerLevel: 'admin' }} slug="payments" />
    );
    expect(screen.getByTestId('admin-spend-hidden')).toBeTruthy();
    expect(screen.queryByText('Not available')).toBeNull();
  });

  it('decides by the sent fields, never by the viewer level or a platform role', () => {
    // viewerLevel says "admin" but the server sent neither panel: nothing is inferred.
    render(<TeamOverviewView overview={{ ...base, viewerLevel: 'admin' }} slug="payments" />);
    expect(screen.queryByTestId('lead-panel')).toBeNull();
    expect(screen.queryByTestId('admin-panel')).toBeNull();
  });

  it('words the Budget card by the scope the server sent', () => {
    render(
      <TeamOverviewView
        overview={{
          ...base,
          budget: { alertThresholdPercent: 80, percentUsed: 60, scope: 'team', state: 'ok' },
        }}
        slug="payments"
      />
    );
    expect(
      within(screen.getByTestId('budget-panel')).getByRole('progressbar').getAttribute('aria-label')
    ).toBe('Team budget');
    expect(screen.getByTestId('budget-meter').textContent).toContain('60% of the team budget');
  });

  it('links an admin-level viewer from the Budget card to the Settings budget section only', () => {
    const budget = {
      alertThresholdPercent: null,
      percentUsed: 10,
      scope: 'org' as const,
      state: 'ok' as const,
    };
    const { rerender } = render(
      <TeamOverviewView overview={{ ...base, budget, viewerLevel: 'admin' }} slug="payments" />
    );
    expect(screen.getByRole('link', { name: 'Manage budget' }).getAttribute('href')).toBe(
      '/teams/payments/settings?tab=budget'
    );
    rerender(
      <TeamOverviewView overview={{ ...base, budget, viewerLevel: 'lead' }} slug="payments" />
    );
    expect(screen.queryByRole('link', { name: 'Manage budget' })).toBeNull();
    rerender(
      <TeamOverviewView
        canManageBudget
        overview={{ ...base, budget, viewerLevel: 'engineer' }}
        slug="payments"
      />
    );
    expect(screen.getByRole('link', { name: 'Manage budget' })).toBeTruthy();
  });

  it('marks repositories with canLaunch off as view only', () => {
    render(<TeamOverviewView overview={base} slug="payments" />);
    expect(screen.getAllByText('View only')).toHaveLength(1);
    expect(screen.getByText('acme/shared-ui').closest('li')?.textContent).toContain('View only');
    expect(screen.getByTitle('acme/api').closest('li')?.textContent).not.toContain('View only');
  });

  it('shows the owner budget meter on a shared repository, and hides it when null', () => {
    const withBudget: TeamOverview = {
      ...base,
      repos: [
        base.repos[0],
        {
          ...base.repos[1],
          launchBudget: {
            alertThresholdPercent: 80,
            percentUsed: 62.4,
            scope: 'team',
            state: 'ok',
          },
        },
      ],
    };
    const { unmount } = render(<TeamOverviewView overview={withBudget} slug="payments" />);
    const line = screen.getByTestId('repo-launch-budget');
    expect(within(line).getByText("Launches here follow Design's budget")).toBeTruthy();
    expect(within(line).getByText('62% of the team budget this month')).toBeTruthy();
    unmount();
    render(<TeamOverviewView overview={base} slug="payments" />);
    expect(screen.queryByTestId('repo-launch-budget')).toBeNull();
  });

  it('renders My work before Team numbers at every viewer level', () => {
    const levels: TeamOverview[] = [
      { ...base, viewerLevel: 'engineer' },
      {
        ...base,
        lead: { openPullRequests: 0, staleApprovals: 0, unownedFailures: 0 },
        viewerLevel: 'lead',
      },
      {
        ...base,
        admin: { monthCostUsdCents: 100 },
        lead: { openPullRequests: 0, staleApprovals: 0, unownedFailures: 0 },
        viewerLevel: 'admin',
      },
    ];
    for (const overview of levels) {
      const { unmount } = render(<TeamOverviewView overview={overview} slug="payments" />);
      const mine = screen.getByLabelText('My work');
      const numbers = screen.getByLabelText('Team numbers');
      expect(mine.compareDocumentPosition(numbers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      unmount();
    }
  });

  it('shows the caller own running, failed and PR figures, each linked to its filtered page', () => {
    render(
      <TeamOverviewView
        overview={{ ...base, mine: { failed: 2, prsAwaitingMerge: 1, running: 3 } }}
        slug="payments"
      />
    );
    const card = within(screen.getByTestId('my-work'));
    expect(card.getByText('3')).toBeTruthy();
    expect(card.getByText('2')).toBeTruthy();
    expect(card.getByText('1')).toBeTruthy();
    expect(card.getByRole('link', { name: 'View running' }).getAttribute('href')).toBe(
      '/requests?scope=MINE&state=active&team=payments'
    );
    expect(card.getByRole('link', { name: 'View failed' }).getAttribute('href')).toBe(
      '/requests?scope=MINE&state=failed&team=payments'
    );
    expect(card.getByRole('link', { name: 'View PRs awaiting merge' }).getAttribute('href')).toBe(
      '/pull-requests?scope=MINE&state=OPEN&team=payments'
    );
  });

  it('shows Start work on a launchable repository, linked to the team start page', () => {
    render(<TeamOverviewView overview={base} slug="payments" />);
    const launchable = screen.getByTitle('acme/api').closest('li');
    expect(
      within(launchable as HTMLElement).getByRole('link', { name: 'Start work' })
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start work' }).getAttribute('href')).toBe(
      '/start?team=payments'
    );
  });

  it('shows the view-only badge and no Start work link on a repository that cannot launch', () => {
    render(<TeamOverviewView overview={base} slug="payments" />);
    const viewOnly = screen.getByText('acme/shared-ui').closest('li') as HTMLElement;
    expect(within(viewOnly).getByText('View only')).toBeTruthy();
    expect(within(viewOnly).queryByRole('link', { name: 'Start work' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Start work' })).toHaveLength(1);
  });
});
