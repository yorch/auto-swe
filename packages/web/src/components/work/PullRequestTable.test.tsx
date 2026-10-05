// @vitest-environment jsdom

import type { PullRequestListItem } from '@auto-swe/shared/types/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PullRequestTable } from './PullRequestTable';

afterEach(cleanup);

const pr = (over: Partial<PullRequestListItem> = {}): PullRequestListItem => ({
  ciStatus: 'PASSED',
  closedAt: null,
  costUsd: 1.5,
  id: 'pr-1',
  isDraft: false,
  latestRun: { id: 'run-1', status: 'SUCCESS' },
  mergedAt: null,
  openedAt: new Date().toISOString(),
  prNumber: 12,
  repository: { id: 'repo-1', name: 'api', org: 'acme' },
  status: 'OPEN',
  ticketId: 'JIRA-9',
  title: 'Fix login',
  url: 'https://github.com/acme/api/pull/12',
  workRequestId: 'wr-1',
  ...over,
});

describe('PullRequestTable', () => {
  it('links the PR on its host, the run and the request', () => {
    render(<PullRequestTable pullRequests={[pr()]} />);
    const host = screen.getByRole('link', { name: /acme\/api #12/ });
    expect(host.getAttribute('href')).toBe('https://github.com/acme/api/pull/12');
    expect(host.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: /Open run/ }).getAttribute('href')).toBe('/runs/run-1');
    expect(screen.getByRole('link', { name: 'JIRA-9' }).getAttribute('href')).toBe(
      '/workflows?request=wr-1'
    );
    expect(screen.getByText('CI passed')).toBeTruthy();
  });

  it('renders a hostile title as text, and does not link a non-http(s) address', () => {
    const { container } = render(
      <PullRequestTable
        pullRequests={[pr({ title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' })]}
      />
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link', { name: /acme\/api #12/ })).toBeNull();
    expect(screen.getByText('acme/api #12')).toBeTruthy();
  });

  it('shows CI only while the PR is open and tolerates missing links', () => {
    render(
      <PullRequestTable
        pullRequests={[
          pr({
            latestRun: null,
            status: 'MERGED',
            ticketId: null,
            title: null,
            workRequestId: null,
          }),
        ]}
      />
    );
    expect(screen.queryByText('CI passed')).toBeNull();
    expect(screen.getByText('Merged')).toBeTruthy();
    expect(screen.getByText('Untitled pull request')).toBeTruthy();
  });
});
