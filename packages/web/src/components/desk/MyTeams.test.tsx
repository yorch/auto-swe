// @vitest-environment jsdom

import type { MeSummaryTeam } from '@auto-swe/shared/types/api';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MyTeams } from './MyTeams';

afterEach(cleanup);

const team = (overrides: Partial<MeSummaryTeam> = {}): MeSummaryTeam => ({
  budget: null,
  myRole: 'LEAD',
  name: 'Payments',
  needsYou: 3,
  orgId: 'o1',
  orgName: 'Acme',
  queued: 2,
  running: 1,
  slug: 'payments',
  teamId: 't1',
  ...overrides,
});

describe('MyTeams', () => {
  it('renders nothing for a user in no team', () => {
    const { container } = render(<MyTeams teams={[]} />);
    expect(container.textContent).toBe('');
  });

  it('collapses a single team to one line', () => {
    render(<MyTeams teams={[team()]} />);
    expect(screen.getByTestId('single-team').textContent).toBe('You are in Payments (Acme).');
    expect(screen.getByRole('link', { name: 'Payments' }).getAttribute('href')).toBe(
      '/teams/payments'
    );
    expect(screen.queryByTestId('team-card')).toBeNull();
  });

  it('shows a card per team with org, role and counts, each linking to the team’s space', () => {
    render(
      <MyTeams
        teams={[
          team(),
          team({ myRole: 'ENGINEER', name: 'Platform', slug: 'platform', teamId: 't2' }),
        ]}
      />
    );
    const cards = screen.getAllByTestId('team-card');
    expect(cards).toHaveLength(2);
    const first = within(cards[0] as HTMLElement);
    expect(first.getByText('Payments')).toBeTruthy();
    expect(first.getByText('Acme')).toBeTruthy();
    expect(first.getByText('Lead')).toBeTruthy();
    expect(first.getByText('Needs you').nextSibling?.textContent).toBe('3');
    expect(first.getByText('Running').nextSibling?.textContent).toBe('1');
    expect(first.getByText('Queued').nextSibling?.textContent).toBe('2');
    expect(within(cards[1] as HTMLElement).getByText('Engineer')).toBeTruthy();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/teams/payments',
      '/teams/platform',
    ]);
  });

  it('shows the budget meter on a card, and none when the team has no budget', () => {
    render(
      <MyTeams
        teams={[
          team({
            budget: { alertThresholdPercent: 80, percentUsed: 72, scope: 'org', state: 'ok' },
          }),
          team({ name: 'Platform', slug: 'platform', teamId: 't2' }),
        ]}
      />
    );
    const cards = screen.getAllByTestId('team-card');
    expect(
      within(cards[0] as HTMLElement).getByRole('progressbar', {
        name: 'Organization budget',
      })
    ).toBeTruthy();
    expect(within(cards[1] as HTMLElement).queryByTestId('budget-meter')).toBeNull();
  });

  it('says in words when the org budget is exceeded', () => {
    render(
      <MyTeams
        teams={[
          team({
            budget: { alertThresholdPercent: null, percentUsed: 130, scope: 'org', state: 'over' },
          }),
          team({ name: 'Platform', slug: 'platform', teamId: 't2' }),
        ]}
      />
    );
    expect(screen.getByText('Over the org budget')).toBeTruthy();
  });

  it('words the meter by the scope the server sent', () => {
    render(
      <MyTeams
        teams={[
          team({
            budget: { alertThresholdPercent: 80, percentUsed: 30, scope: 'team', state: 'ok' },
          }),
          team({
            budget: { alertThresholdPercent: null, percentUsed: 30, scope: 'org', state: 'ok' },
            slug: 'platform',
            teamId: 't2',
          }),
        ]}
      />
    );
    const meters = screen.getAllByTestId('budget-meter').map((m) => m.textContent);
    expect(meters[0]).toContain('30% of the team budget this month');
    expect(meters[1]).toContain('30% of the org budget this month');
  });
});
