// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CiBadge, PullRequestStateBadge, pullRequestStateMeta } from './PullRequestBadges';

afterEach(cleanup);

describe('pullRequestStateMeta', () => {
  it('names the four states a reader tells apart', () => {
    expect(pullRequestStateMeta('OPEN', false).label).toBe('Open');
    expect(pullRequestStateMeta('OPEN', true).label).toBe('Draft');
    expect(pullRequestStateMeta('MERGED', false).label).toBe('Merged');
    expect(pullRequestStateMeta('CLOSED', false).label).toBe('Closed');
  });

  it('never calls a finished PR a draft', () => {
    expect(pullRequestStateMeta('MERGED', true).label).toBe('Merged');
    expect(pullRequestStateMeta('CLOSED', true).label).toBe('Closed');
  });
});

describe('badges', () => {
  it('renders the state and the CI verdict as words', () => {
    render(
      <>
        <PullRequestStateBadge isDraft status="OPEN" />
        <CiBadge status="FAILED" />
        <CiBadge status="PASSED" />
        <CiBadge status="PENDING" />
      </>
    );
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('CI failed')).toBeTruthy();
    expect(screen.getByText('CI passed')).toBeTruthy();
    expect(screen.getByText('CI pending')).toBeTruthy();
  });
});
