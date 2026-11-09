// @vitest-environment jsdom

import type { BudgetState, BudgetStatus } from '@auto-swe/shared/types/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetMeter } from './BudgetMeter';

afterEach(cleanup);

const budget = (over: Partial<BudgetStatus>): BudgetStatus => ({
  alertThresholdPercent: 80,
  percentUsed: 72,
  scope: 'org',
  state: 'ok',
  ...over,
});

describe('BudgetMeter', () => {
  it('renders nothing without a budget', () => {
    const { container } = render(<BudgetMeter budget={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('describes an ok budget as a progressbar with a text label', () => {
    render(<BudgetMeter budget={budget({})} />);
    const bar = screen.getByRole('progressbar', { name: 'Organization budget' });
    expect(bar.getAttribute('aria-valuetext')).toBe('72% of the org budget this month');
    expect(bar.getAttribute('aria-valuenow')).toBe('72');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(screen.getByText('Alerts at 80%.')).toBeTruthy();
  });

  it('says team budget for a team scope', () => {
    render(<BudgetMeter budget={budget({ scope: 'team' })} />);
    expect(screen.getByText('72% of the team budget this month')).toBeTruthy();
  });

  it.each<[BudgetState, number | null, RegExp]>([
    ['alert', 85, /85% of the org budget this month, nearing the limit/],
    ['projected_over', 70, /70% of the org budget this month, on track to pass it/],
    ['over', 120, /^Over the org budget$/],
  ])('labels %s in words, not colour alone', (state, percentUsed, text) => {
    render(<BudgetMeter budget={budget({ percentUsed, state })} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByTestId('budget-meter').getAttribute('data-state')).toBe(state);
  });

  it('never shows 100% unless the budget is over', () => {
    render(<BudgetMeter budget={budget({ percentUsed: 99.96, state: 'alert' })} />);
    expect(screen.getByText(/^99% of the org budget/)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('99');
  });

  it('names the state once for assistive tech: the value text, not also the name', () => {
    render(<BudgetMeter budget={budget({})} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-label')).not.toContain('72%');
    expect(bar.getAttribute('aria-valuetext')).toContain('72%');
  });

  it('caps an over-budget bar at 100', () => {
    render(<BudgetMeter budget={budget({ percentUsed: 140, state: 'over' })} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('shows only a label when there is no cap', () => {
    render(<BudgetMeter budget={budget({ percentUsed: null, state: 'no_cap' })} />);
    expect(screen.getByText('No budget limit')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('is compact without the threshold note', () => {
    render(<BudgetMeter budget={budget({})} variant="compact" />);
    expect(screen.queryByText('Alerts at 80%.')).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });
});
