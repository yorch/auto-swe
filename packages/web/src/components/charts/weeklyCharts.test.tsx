// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DailyCostChart } from './DailyCostChart';
import { ScorerBreakdownChart } from './ScorerBreakdownChart';
import { ScorerTrendChart } from './ScorerTrendChart';

const cost = [
  { calls: 4, costUsd: 1.5, date: '2026-06-01' },
  { calls: 2, costUsd: 0.5, date: '2026-06-08' },
];
const trend = [
  { date: '2026-06-01', mean: 0.8, n: 3 },
  { date: '2026-06-08', mean: null, n: 0 },
  { date: '2026-06-15', mean: 0.6, n: 2 },
];

describe('weekly buckets', () => {
  it('names the cost chart by week, in its summary and its table', () => {
    render(<DailyCostChart data={cost} granularity="week" />);
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('Weekly LLM cost');
    expect(label).toContain('over 2 weeks');
    expect(label).toContain('Highest week');
    expect(label).not.toMatch(/daily|days/i);
    expect(screen.getByRole('columnheader', { name: 'Week starting (UTC)' })).toBeTruthy();
  });

  it('keeps the cost chart daily by default', () => {
    render(<DailyCostChart data={cost} />);
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('Daily LLM cost');
    expect(label).toContain('over 2 days');
    expect(screen.getByRole('columnheader', { name: 'Date (UTC)' })).toBeTruthy();
  });

  it('names the scorer trend by week', () => {
    render(<ScorerTrendChart data={trend} granularity="week" />);
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('Weekly mean score');
    expect(label).toContain('over 3 weeks; 2 weeks have signals');
    expect(screen.getByRole('columnheader', { name: 'Week starting (UTC)' })).toBeTruthy();
  });

  it('names the scorer breakdown by week', () => {
    render(
      <ScorerBreakdownChart
        granularity="week"
        series={[
          { daily: trend, label: 'a' },
          { daily: trend, label: 'b' },
        ]}
      />
    );
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('Weekly mean score');
    expect(label).toContain('over 3 weeks');
    expect(screen.getByRole('columnheader', { name: 'Week starting (UTC)' })).toBeTruthy();
  });
});
