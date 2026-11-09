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
  last7d: { failed: 1, started: 4, succeeded: 3 },
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
    { id: 'r1', name: 'acme/api', ownerTeamName: null, relation: 'owned' },
    { id: 'r2', name: 'acme/shared-ui', ownerTeamName: 'Design', relation: 'shared' },
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
    expect(screen.getByText('shared from Design')).toBeTruthy();
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

  it('decides by the sent fields, never by the viewer level or a platform role', () => {
    // viewerLevel says "admin" but the server sent neither panel: nothing is inferred.
    render(<TeamOverviewView overview={{ ...base, viewerLevel: 'admin' }} slug="payments" />);
    expect(screen.queryByTestId('lead-panel')).toBeNull();
    expect(screen.queryByTestId('admin-panel')).toBeNull();
  });
});
