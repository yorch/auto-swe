// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformUsage } from '@/hooks/useAdmin';

const usePlatformUsage = vi.fn();
const auth = vi.hoisted(() => ({
  isAdmin: true,
  ledTeamIds: new Set<string>() as Set<string> | null,
}));
vi.mock('@/hooks/useAdmin', () => ({
  usePlatformUsage: (...args: unknown[]) => usePlatformUsage(...args),
  useUserOrgs: () => ({ data: [{ id: 'org-1', name: 'Acme', role: 'ORG_ADMIN' }] }),
}));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => auth.isAdmin }));
vi.mock('@/hooks/useTeams', () => ({
  useLedTeamIds: () => auth.ledTeamIds,
  useTeams: () => ({
    data: [
      { id: 'team-a', name: 'Payments' },
      { id: 'team-b', name: 'Platform' },
    ],
  }),
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
  byOrg: [{ ...bucket, orgId: 'org-1', orgName: 'Acme' }],
  byTeam: [
    { ...bucket, orgId: 'org-1', teamId: 'team-a', teamName: 'Payments' },
    { ...bucket, orgId: null, teamId: null, teamName: null },
  ],
  daily: [],
  scope: {},
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
  auth.isAdmin = true;
  auth.ledTeamIds = new Set();
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

  it('breaks spend down by team and organization, naming spend no team owns', () => {
    render(<UsagePage />);

    expect(screen.getByText('By team')).toBeTruthy();
    expect(screen.getByText('(no team)')).toBeTruthy();
    expect(screen.getByText('By organization')).toBeTruthy();
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
  });

  it('shows an ADMIN the whole platform by default', () => {
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(30, {}, true);
  });

  it("shows a LEAD their first team's report, never the whole platform", () => {
    auth.isAdmin = false;
    auth.ledTeamIds = new Set(['team-b']);
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(30, { teamId: 'team-b' }, true);
  });

  it('asks for nothing until a LEAD’s teams are known', () => {
    auth.isAdmin = false;
    auth.ledTeamIds = null;
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(30, {}, false);
  });

  it('refetches for the chosen window', () => {
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(30, {}, true);

    fireEvent.click(screen.getByRole('button', { name: '7d' }));

    expect(usePlatformUsage).toHaveBeenLastCalledWith(7, {}, true);
  });

  it('shows the error when the report fails to load, not a spinner', () => {
    usePlatformUsage.mockReturnValue({
      data: undefined,
      error: new Error('forbidden'),
      isError: true,
      isLoading: false,
    });

    render(<UsagePage />);

    expect(screen.getByText(/Could not load LLM usage/)).toBeTruthy();
  });
});
