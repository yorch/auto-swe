// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformUsage } from '@/hooks/useAdmin';

const nav = vi.hoisted(() => ({ params: '', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/govern/usage',
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.params),
}));

const usePlatformUsage = vi.fn();
type Scopes = {
  platform: boolean;
  teams: { id: string; name: string }[];
  orgs: { id: string; name: string }[];
};
const auth = vi.hoisted(() => ({ scopes: undefined as unknown }));
vi.mock('@/hooks/useAdmin', () => ({
  usePlatformUsage: (...args: unknown[]) => usePlatformUsage(...args),
  useUsageScopes: () => ({ data: auth.scopes, isError: false, isLoading: false }),
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
  previous: { calls: 2, costUsd: 2 },
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

const P30 = { days: 30, kind: 'preset' };

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
  nav.params = '';
  nav.replace.mockReset();
  usePlatformUsage.mockReset().mockReturnValue({ data: usage, isLoading: false });
});

describe('UsagePage', () => {
  it('renders spend with its previous-period context, and links the costliest runs', () => {
    render(<UsagePage />);

    expect(screen.getByText('Spend outside workflow runs')).toBeTruthy();
    expect(screen.getByText(/\+25% vs previous 30 days/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'JIRA-7' }).getAttribute('href')).toBe('/runs/run-7');
  });

  it('breaks spend down over one table, switched by a control, naming spend no team owns', () => {
    render(<UsagePage />);

    // The default breakdown is by model; unresolved models are named in words.
    expect(screen.getByText('Model not resolved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Team' }));
    expect(screen.getByText('Not attributed to a team')).toBeTruthy();
    expect(screen.getByText('Payments')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByText('Execute implementation')).toBeTruthy();
  });

  it('shows one page-level empty state instead of empty tables', () => {
    usePlatformUsage.mockReturnValue({
      data: { ...usage, totals: { ...bucket, calls: 0, costUsd: 0, errors: 0 } },
      isLoading: false,
    });
    render(<UsagePage />);
    expect(screen.getAllByText('No LLM calls in this window.')).toHaveLength(1);
  });

  it('dims the previous scope while the next one loads', () => {
    usePlatformUsage.mockReturnValue({ data: usage, isLoading: false, isPlaceholderData: true });
    render(<UsagePage />);
    expect(screen.getByRole('status').textContent).toBe('Updating…');
  });

  it('shows an ADMIN the whole platform by default', () => {
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(P30, {}, true);
  });

  it("shows a team LEAD their first team's report, never the whole platform", () => {
    auth.scopes = { orgs: [], platform: false, teams: [{ id: 'team-b', name: 'Platform' }] };
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(P30, { teamId: 'team-b' }, true);
  });

  it('offers an ORG_ADMIN with no led team their organization', () => {
    auth.scopes = { orgs: [{ id: 'org-1', name: 'Acme' }], platform: false, teams: [] };
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(P30, { orgId: 'org-1' }, true);
  });

  it('asks for nothing until the scopes are known', () => {
    auth.scopes = undefined;
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(P30, {}, false);
  });

  it('says so when the caller holds no scope', () => {
    auth.scopes = { orgs: [], platform: false, teams: [] };
    render(<UsagePage />);
    expect(screen.getByText(/no usage you can see/)).toBeTruthy();
  });

  it('refetches for the chosen window', () => {
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(P30, {}, true);

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    expect(nav.replace).toHaveBeenCalledWith('/govern/usage?range=7', { scroll: false });

    nav.params = 'range=90';
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith({ days: 90, kind: 'preset' }, {}, true);
  });

  it('serves a custom range from the link, with no notice that it was ignored', () => {
    nav.params = 'range=custom&from=2026-09-01&to=2026-09-14';
    render(<UsagePage />);
    expect(usePlatformUsage).toHaveBeenLastCalledWith(
      { from: '2026-09-01', kind: 'custom', to: '2026-09-14' },
      {},
      true
    );
    expect(screen.queryByText(/only offers 7, 30 and 90/)).toBeNull();
    expect(screen.getByLabelText('From date (UTC)')).toBeTruthy();
    expect(screen.getByText(/for 2026-09-01 to 2026-09-14 \(UTC\)/)).toBeTruthy();
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
