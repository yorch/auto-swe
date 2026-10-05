// @vitest-environment jsdom

import type { TicketGroup } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { runSummary, TicketTable } from './TicketTable';

afterEach(cleanup);

const group = (over: Partial<TicketGroup> = {}): TicketGroup => ({
  costUsd: 5.5,
  lastActivityAt: new Date().toISOString(),
  latestRun: { id: 'run-1', status: 'FAILED' },
  latestWorkRequestId: 'wr-1',
  pullRequests: [
    {
      id: 'pr-1',
      isDraft: false,
      prNumber: 3,
      repository: { id: 'r', name: 'api', org: 'acme' },
      status: 'MERGED',
      url: 'https://github.com/acme/api/pull/3',
    },
  ],
  requestCount: 2,
  runCounts: { FAILED: 1, SUCCESS: 2 },
  status: 'In Progress',
  ticketId: 'JIRA-1',
  title: 'Fix login',
  url: 'https://jira.test/JIRA-1',
  ...over,
});

describe('runSummary', () => {
  it('spells counts out, and says when there are none', () => {
    expect(runSummary({ FAILED: 1, TIMED_OUT: 2 })).toBe('1 failed, 2 timed out');
    expect(runSummary({})).toBe('No runs');
  });
});

describe('TicketTable', () => {
  it('links the ticket in its tracker', () => {
    render(<TicketTable groups={[group()]} />);
    const link = screen.getByRole('link', { name: /JIRA-1/ });
    expect(link.getAttribute('href')).toBe('https://jira.test/JIRA-1');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText('Fix login')).toBeTruthy();
  });

  it('shows tracker text as text and links nothing that is not http(s)', () => {
    const { container } = render(
      <TicketTable
        groups={[group({ title: '<b onmouseover=alert(1)>x</b>', url: 'javascript:alert(1)' })]}
      />
    );
    expect(screen.queryByRole('link', { name: /JIRA-1/ })).toBeNull();
    expect(screen.getByText('JIRA-1')).toBeTruthy();
    expect(screen.getByText('<b onmouseover=alert(1)>x</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
  });

  it('expands to the latest request, the ticket’s requests and its pull requests', () => {
    render(<TicketTable groups={[group()]} />);
    const toggle = screen.getByRole('button', { name: /Show details/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: 'Open latest request' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open latest request' }).getAttribute('href')).toBe(
      '/workflows?request=wr-1'
    );
    expect(
      screen.getByRole('link', { name: 'All requests for this ticket' }).getAttribute('href')
    ).toBe('/workflows?scope=TEAM&search=JIRA-1');
    expect(screen.getByRole('link', { name: /acme\/api #3/ }).getAttribute('href')).toBe(
      'https://github.com/acme/api/pull/3'
    );
    expect(screen.getByText('Merged')).toBeTruthy();
  });
});
