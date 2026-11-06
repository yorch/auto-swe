// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRunOutcomeCard } from './AgentRunOutcomeCard';
import { RunOutcomeCard } from './RunOutcomeCard';

afterEach(cleanup);

const RESULT = { prNumber: 12, prUrl: 'https://github.com/acme/api/pull/12' };
const AGENT = {
  branch: 'auto/agent-abc',
  deliver: 'draft_pr',
  diff: 'diff --git a/a.md b/a.md\n+hello',
  diffTruncated: false,
  diffVerified: true,
  filesChanged: [{ linesAdded: 1, linesRemoved: 0, operation: 'CREATE', path: 'a.md' }],
  gate: 'passed',
  headSha: 'abc123',
  prNumber: 7,
  prUrl: 'https://github.com/acme/api/pull/7',
  text: 'Added a.md',
};

describe('the pull request outcome of a workflow run', () => {
  it('opens the review page inside the dashboard and still reaches the host', () => {
    render(
      <RunOutcomeCard
        pullRequestId="pr-1"
        result={RESULT}
        runId="run-1"
        templateName="ticket-to-pr"
      />
    );
    const review = screen.getByRole('link', { name: 'Open review' });
    expect(review.getAttribute('href')).toBe('/pull-requests/pr-1');
    expect(review.getAttribute('target')).toBeNull();
    const host = screen.getByRole('link', { name: /PR #12 on the host/ });
    expect(host.getAttribute('href')).toBe('https://github.com/acme/api/pull/12');
    expect(host.getAttribute('target')).toBe('_blank');
    expect(host.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps the host link as it was when there is no review page to offer', () => {
    render(<RunOutcomeCard result={RESULT} runId="run-1" templateName="ticket-to-pr" />);
    expect(screen.queryByRole('link', { name: 'Open review' })).toBeNull();
    expect(screen.getByRole('link', { name: /Review PR #12/ }).getAttribute('href')).toBe(
      'https://github.com/acme/api/pull/12'
    );
  });

  it('treats a null id as no review page', () => {
    render(
      <RunOutcomeCard
        pullRequestId={null}
        result={RESULT}
        runId="run-1"
        templateName="ticket-to-pr"
      />
    );
    expect(screen.queryByRole('link', { name: 'Open review' })).toBeNull();
  });

  it('words the host link without a number when the result carries none', () => {
    render(
      <RunOutcomeCard
        pullRequestId="pr-1"
        result={{ prUrl: RESULT.prUrl }}
        runId="run-1"
        templateName="ticket-to-pr"
      />
    );
    expect(screen.getByRole('link', { name: /Pull request on the host/ })).toBeTruthy();
  });

  it('builds the address from the id alone, escaped', () => {
    render(
      <RunOutcomeCard
        pullRequestId="a/b?x=1"
        result={RESULT}
        runId="run-1"
        templateName="ticket-to-pr"
      />
    );
    expect(screen.getByRole('link', { name: 'Open review' }).getAttribute('href')).toBe(
      '/pull-requests/a%2Fb%3Fx%3D1'
    );
  });

  it('offers no host link for an address that is not http(s), review page or not', () => {
    render(
      <RunOutcomeCard
        pullRequestId="pr-1"
        result={{ prNumber: 12, prUrl: 'javascript:alert(1)' }}
        runId="run-1"
        templateName="ticket-to-pr"
      />
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the pull request outcome of an agent run', () => {
  it('opens the review page beside the host link', () => {
    render(<AgentRunOutcomeCard pullRequestId="pr-9" result={AGENT} runId="run-1" />);
    expect(screen.getByRole('link', { name: 'Open review' }).getAttribute('href')).toBe(
      '/pull-requests/pr-9'
    );
    expect(screen.getByRole('link', { name: /#7/ }).getAttribute('href')).toBe(
      'https://github.com/acme/api/pull/7'
    );
  });

  it('shows only the host link without one', () => {
    render(<AgentRunOutcomeCard result={AGENT} runId="run-1" />);
    expect(screen.queryByRole('link', { name: 'Open review' })).toBeNull();
    expect(screen.getByRole('link', { name: /#7/ })).toBeTruthy();
  });

  it('passes the id through the generic card for a run the gateway flags as an agent run', () => {
    render(
      <RunOutcomeCard
        isAgentRun
        pullRequestId="pr-9"
        result={AGENT}
        runId="run-1"
        templateName="Agent Run"
      />
    );
    expect(screen.getByRole('link', { name: 'Open review' })).toBeTruthy();
  });

  it('offers it only where the pull request is shown, not for a run that delivered nothing', () => {
    render(
      <AgentRunOutcomeCard
        pullRequestId="pr-9"
        result={{ ...AGENT, deliver: 'none' }}
        runId="run-1"
      />
    );
    expect(screen.queryByRole('link', { name: 'Open review' })).toBeNull();
  });
});
