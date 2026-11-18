// @vitest-environment jsdom

import type { ApprovalLatencySummary } from '@auto-swe/shared/types/api';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApprovalLatencyCard } from './ApprovalLatencyCard';

const latency = (over: Partial<ApprovalLatencySummary> = {}): ApprovalLatencySummary => ({
  cancelled: 1,
  isTruncated: false,
  pending: 2,
  perTemplate: [
    {
      cancelled: 1,
      pending: 2,
      resolved: { count: 4, p50Ms: 120_000, p95Ms: 600_000 },
      templateId: 't1',
      templateName: 'Ticket to PR',
      timedOut: 1,
    },
  ],
  resolved: { count: 4, p50Ms: 120_000, p95Ms: 600_000 },
  timedOut: 1,
  ...over,
});

describe('ApprovalLatencyCard', () => {
  it('uses the singular for a single answered step', () => {
    render(
      <ApprovalLatencyCard
        latency={latency({ resolved: { count: 1, p50Ms: 60_000, p95Ms: 60_000 } })}
      />
    );
    expect(screen.getByText('Based on 1 answered step')).toBeTruthy();
  });

  it('shows the wait percentiles and keeps timed-out, cancelled and pending out of them', () => {
    render(<ApprovalLatencyCard latency={latency()} />);
    expect(screen.getByText('Based on 4 answered steps')).toBeTruthy();
    expect(screen.getByText('Wait, median')).toBeTruthy();
    expect(screen.getAllByText('2m').length).toBeGreaterThan(0);
    expect(screen.getAllByText('10m').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Timed-out and cancelled steps are not in the wait figures/)
    ).toBeTruthy();
    expect(screen.getByText(/2 still waiting are left out too/)).toBeTruthy();
  });

  it('does not mention waiting steps when none is waiting', () => {
    render(<ApprovalLatencyCard latency={latency({ pending: 0 })} />);
    expect(
      screen.getByText(/Timed-out and cancelled steps are not in the wait figures/)
    ).toBeTruthy();
    expect(screen.queryByText(/left out too/)).toBeNull();
  });

  it('breaks the figures down per template', () => {
    render(<ApprovalLatencyCard latency={latency()} />);
    const row = screen.getByText('Ticket to PR').closest('tr') as HTMLElement;
    expect(within(row).getByText('4')).toBeTruthy();
    expect(within(row).getByText('2m')).toBeTruthy();
  });

  it('shows dashes when nothing was answered', () => {
    render(
      <ApprovalLatencyCard
        latency={latency({
          perTemplate: [],
          resolved: { count: 0, p50Ms: null, p95Ms: null },
        })}
      />
    );
    expect(screen.getByText('Based on 0 answered steps')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('says so when no human step was requested', () => {
    render(
      <ApprovalLatencyCard
        latency={latency({
          cancelled: 0,
          pending: 0,
          perTemplate: [],
          resolved: { count: 0, p50Ms: null, p95Ms: null },
          timedOut: 0,
        })}
      />
    );
    expect(screen.getByText('No human steps were requested in this window.')).toBeTruthy();
  });

  it('warns when the row cap cut the read', () => {
    render(<ApprovalLatencyCard latency={latency({ isTruncated: true })} />);
    expect(screen.getByText(/Results capped at the 10,000 most recent steps/)).toBeTruthy();
  });
});
