// @vitest-environment jsdom

import type { PullRequestCockpitSinceVisit } from '@auto-swe/shared/types/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SinceLastVisit } from './SinceLastVisit';

afterEach(cleanup);

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

const since = (over: Partial<PullRequestCockpitSinceVisit> = {}): PullRequestCockpitSinceVisit => ({
  commits: [
    { sha: 'c1c1c1c1c1', subject: 'fix the retry' },
    { sha: 'd2d2d2d2d2', subject: 'add a test' },
  ],
  fromHeadSha: OLD,
  lastVisitedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  rewritten: false,
  totalCommits: 2,
  ...over,
});

const show = (value: PullRequestCockpitSinceVisit) =>
  render(<SinceLastVisit since={value} toHead={NEW} />);

describe('SinceLastVisit', () => {
  it('says where the head was and is now, and lists the commits that came in', () => {
    show(since());
    expect(screen.getByText('Since you last looked')).toBeTruthy();
    expect(screen.getByText('aaaaaaa')).toBeTruthy();
    expect(screen.getByText('bbbbbbb')).toBeTruthy();
    expect(screen.getByText(/2 commits since:/)).toBeTruthy();
    expect(screen.getByText(/fix the retry/)).toBeTruthy();
    expect(screen.getByText(/add a test/)).toBeTruthy();
    expect(screen.getByText('c1c1c1c')).toBeTruthy();
  });

  it('says one commit in the singular', () => {
    show(since({ commits: [{ sha: 'c1c1c1c1c1', subject: 'only one' }], totalCommits: 1 }));
    expect(screen.getByText(/1 commit since:/)).toBeTruthy();
  });

  it('lists ten and counts the rest', () => {
    const commits = Array.from({ length: 14 }, (_, i) => ({
      sha: `${String(i).padStart(2, '0')}c0ffee00`,
      subject: `change ${i}`,
    }));
    show(since({ commits, totalCommits: 30 }));
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText(/and 20 more commits\./)).toBeTruthy();
  });

  it('says a rewritten branch was rewritten, and still lists what it has now', () => {
    show(since({ rewritten: true }));
    expect(screen.getByText(/The branch was rewritten/)).toBeTruthy();
    expect(screen.getByText(/fix the retry/)).toBeTruthy();
  });

  it('says so when a rewritten branch has no commit to list', () => {
    show(since({ commits: [], rewritten: true, totalCommits: 0 }));
    expect(screen.getByText(/The branch was rewritten/)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says the host could not say which commits came in, and lists none', () => {
    show(since({ commits: null, totalCommits: 0 }));
    expect(screen.getByText(/could not say which commits came in/)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText(/more commit/)).toBeNull();
  });

  it('shows a subject as plain text, never as markup', () => {
    show(since({ commits: [{ sha: 'c1c1c1c1c1', subject: '<img src=x onerror=alert(1)>' }] }));
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
  });

  it('makes a hidden character in a subject visible instead of dropping it', () => {
    show(since({ commits: [{ sha: 'c1c1c1c1c1', subject: 'a‮b' }] }));
    expect(screen.queryByText(/a‮b/)).toBeNull();
  });
});
