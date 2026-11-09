// @vitest-environment jsdom

import type { MeNeedsYouItem } from '@auto-swe/shared/types/api';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NeedsYouList, needsYouHref } from './NeedsYouList';

afterEach(cleanup);

function item(overrides: Partial<MeNeedsYouItem> = {}): MeNeedsYouItem {
  return {
    dueAt: null,
    key: 'k1',
    kind: 'failed_run',
    occurredAt: '2026-01-01T00:00:00Z',
    repoName: 'acme/api',
    requestId: 'req-1',
    runId: 'run-1',
    teamId: 't1',
    teamName: 'Payments',
    teamSlug: 'payments',
    title: 'Fix login',
    ...overrides,
  };
}

describe('needsYouHref', () => {
  it('sends approvals to the approvals inbox', () => {
    expect(needsYouHref(item({ kind: 'approval' }))).toBe('/approvals');
    expect(needsYouHref(item({ kind: 'approval_due_soon' }))).toBe('/approvals');
  });

  it('sends a failed run to the run, then its request, then the attention list', () => {
    expect(needsYouHref(item())).toBe('/runs/run-1');
    expect(needsYouHref(item({ runId: null }))).toBe('/requests?request=req-1');
    expect(needsYouHref(item({ requestId: null, runId: null }))).toBe('/requests?state=attention');
  });

  it('sends a pull request to its request, else the pull request list', () => {
    expect(needsYouHref(item({ kind: 'pr_merge' }))).toBe('/requests?request=req-1');
    expect(needsYouHref(item({ kind: 'pr_merge', requestId: null }))).toBe('/pull-requests');
  });
});

describe('NeedsYouList', () => {
  it('shows a calm empty state', () => {
    render(<NeedsYouList items={[]} total={0} />);
    expect(screen.getByText('Nothing needs you')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders each row with kind, title, team chip, repo and action link', () => {
    render(
      <NeedsYouList
        items={[item(), item({ key: 'k2', kind: 'pr_merge', runId: null, title: 'Add retries' })]}
        total={2}
      />
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('Fix login')).toBeTruthy();
    expect(first.getByText('Payments')).toBeTruthy();
    expect(first.getByText('acme/api')).toBeTruthy();
    expect(first.getByText('Failed run')).toBeTruthy();
    expect(first.getByRole('link', { name: /Open run/ }).getAttribute('href')).toBe('/runs/run-1');
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('link', { name: /Review PR/ })
        .getAttribute('href')
    ).toBe('/requests?request=req-1');
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it('falls back to a neutral chip when the item has no team', () => {
    render(
      <NeedsYouList items={[item({ teamId: null, teamName: null, teamSlug: null })]} total={1} />
    );
    expect(screen.getByText('No team')).toBeTruthy();
  });

  it('shows the due time for approvals and highlights one that is due soon', () => {
    const dueAt = new Date(Date.now() + 30 * 60_000).toISOString();
    render(
      <NeedsYouList
        items={[
          item({ dueAt, key: 'a', kind: 'approval_due_soon', title: 'Ship it' }),
          item({ dueAt, key: 'b', kind: 'approval', title: 'Later' }),
        ]}
        total={2}
      />
    );
    const [soon, normal] = screen.getAllByText(/^Due/);
    expect(soon?.className).toContain('text-warning-400');
    expect(normal?.className).not.toContain('text-warning-400');
    expect(soon?.querySelector('time')).toBeTruthy();
  });

  it('says how many are shown of the total and links to the full list', () => {
    render(<NeedsYouList items={[item({ kind: 'approval' })]} total={31} />);
    expect(screen.getByText(/Showing 1 of 31/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /View all/ }).getAttribute('href')).toBe('/approvals');
    cleanup();
    render(<NeedsYouList items={[item()]} total={31} />);
    expect(screen.getByRole('link', { name: /View all/ }).getAttribute('href')).toBe(
      '/requests?state=attention'
    );
  });
});
