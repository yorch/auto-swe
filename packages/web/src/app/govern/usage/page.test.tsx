// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformUsage } from '@/hooks/useAdmin';

const usePlatformUsage = vi.fn();
vi.mock('@/hooks/useAdmin', () => ({
  usePlatformUsage: (days: number) => usePlatformUsage(days),
}));
// Recharts needs a laid-out container; the chart has nothing page-specific to check.
vi.mock('@/components/charts/DailyCostChart', () => ({
  DailyCostChart: () => <div data-testid="daily-chart" />,
}));

import UsagePage from './page';

const bucket = {
  avgDurationMs: 1200,
  calls: 4,
  costUsd: 2.5,
  errors: 1,
  inputTokens: 1000,
  outputTokens: 100,
};

const usage: PlatformUsage = {
  byActivity: [{ ...bucket, nodeId: 'executeImplementation' }],
  byAgent: [{ ...bucket, agentKey: 'embedding' }],
  byModel: [{ ...bucket, model: null }],
  daily: [],
  since: '2026-09-01T00:00:00.000Z',
  topRuns: [
    {
      costUsd: 2,
      externalTicketId: 'JIRA-7',
      inputTokens: 10,
      outputTokens: 1,
      runId: 'run-7',
      startedAt: '2026-09-02T00:00:00.000Z',
      status: 'SUCCESS',
      templateName: 'Ticket to PR',
    },
  ],
  totals: bucket,
  unattributed: { calls: 2, costUsd: 0.4 },
  until: '2026-10-01T00:00:00.000Z',
  windowDays: 30,
};

beforeEach(() => {
  usePlatformUsage.mockReset().mockReturnValue({ data: usage, isLoading: false });
});

describe('UsagePage', () => {
  it('renders spend, breakdowns, and links the costliest runs', () => {
    render(<UsagePage />);

    expect(screen.getByText('Without a run')).toBeTruthy();
    expect(screen.getByText('(unresolved)')).toBeTruthy();
    expect(screen.getByText('embedding')).toBeTruthy();
    expect(screen.getByText('executeImplementation')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'JIRA-7' }).getAttribute('href')).toBe('/runs/run-7');
  });

  it('refetches for the chosen window', () => {
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(30);

    fireEvent.click(screen.getByRole('button', { name: '7d' }));

    expect(usePlatformUsage).toHaveBeenLastCalledWith(7);
  });
});
