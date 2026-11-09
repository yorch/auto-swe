// @vitest-environment jsdom

import type { MeSummaryTeam } from '@auto-swe/shared/types/api';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MyTeams } from './MyTeams';

afterEach(cleanup);

const team = (overrides: Partial<MeSummaryTeam> = {}): MeSummaryTeam => ({
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
    expect(screen.queryByTestId('team-card')).toBeNull();
  });

  it('shows a card per team with org, role and counts, and no links', () => {
    render(
      <MyTeams teams={[team(), team({ myRole: 'ENGINEER', name: 'Platform', teamId: 't2' })]} />
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
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
