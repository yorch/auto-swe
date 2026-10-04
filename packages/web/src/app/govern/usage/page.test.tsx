// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformUsage } from '@/hooks/useAdmin';

const usePlatformUsage = vi.fn();
type Scopes = {
  platform: boolean;
  teams: { id: string; name: string }[];
  orgs: { id: string; name: string }[];
};
const auth = vi.hoisted(() => ({ scopes: undefined as unknown }));
vi.mock('@/hooks/useAdmin', () => ({
  usePlatformUsage: (...args: unknown[]) => usePlatformUsage(...args),
  useUsageScopes: () => ({ data: auth.scopes }),
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

const ADMIN_SCOPES: Scopes = {
  orgs: [{ id: 'org-1', name: 'Acme' }],
  platform: true,
  teams: [
    { id: 'team-a', name: 'Payments' },
    { id: 'team-b', name: 'Platform' },
  ],
};

beforeEach(() => {
  auth.scopes = ADMIN_SCOPES;
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

  it("shows a team LEAD their first team's report, never the whole platform", () => {
    auth.scopes = { orgs: [], platform: false, teams: [{ id: 'team-b', name: 'Platform' }] };
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(30, { teamId: 'team-b' }, true);
  });

  it('offers an ORG_ADMIN with no led team their organization', () => {
    auth.scopes = { orgs: [{ id: 'org-1', name: 'Acme' }], platform: false, teams: [] };
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(30, { orgId: 'org-1' }, true);
  });

  it('asks for nothing until the scopes are known', () => {
    auth.scopes = undefined;
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(30, {}, false);
  });

  it('says so when the caller holds no scope', () => {
    auth.scopes = { orgs: [], platform: false, teams: [] };
    render(<UsagePage />);
    expect(screen.getByText(/no usage you can see/)).toBeTruthy();
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
