// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRunFailureNote, AgentRunOutcomeCard } from './AgentRunOutcomeCard';
import { RunOutcomeCard } from './RunOutcomeCard';

afterEach(cleanup);

const DELIVERED = {
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

describe('AgentRunOutcomeCard', () => {
  it('shows the summary, files, branch, draft PR link and the verified/gate badges', () => {
    render(<AgentRunOutcomeCard result={DELIVERED} />);
    expect(screen.getByText('Added a.md')).toBeTruthy();
    expect(screen.getByText('a.md')).toBeTruthy();
    expect(screen.getByText('auto/agent-abc')).toBeTruthy();
    expect(screen.getByText('Diff verified')).toBeTruthy();
    expect(screen.getByText('Passed the security gate')).toBeTruthy();
    const link = screen.getByRole('link', { name: /#7/ });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/api/pull/7');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('labels a deliver:none diff as the agent’s own, unverified, and shows no branch or PR', () => {
    render(
      <AgentRunOutcomeCard
        result={{
          deliver: 'none',
          diff: '+x',
          diffVerified: false,
          gate: 'not_applicable',
          text: 'ok',
        }}
      />
    );
    expect(screen.getByText('Diff unverified')).toBeTruthy();
    expect(screen.getByText(/for reading, not for trust/)).toBeTruthy();
    expect(screen.queryByText('Branch')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('never links a non-https PR URL', () => {
    render(<AgentRunOutcomeCard result={{ ...DELIVERED, prUrl: 'javascript:alert(1)' }} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says when a run stopped at a cap and when the diff was cut', () => {
    render(
      <AgentRunOutcomeCard
        result={{ ...DELIVERED, diffTruncated: true, stoppedReason: 'wall_clock' }}
      />
    );
    expect(screen.getByText('Stopped at its time limit')).toBeTruthy();
    expect(screen.getByText(/Show diff \(truncated\)/)).toBeTruthy();
  });

  it('renders agent text as text, not markup', () => {
    const { container } = render(
      <AgentRunOutcomeCard result={{ text: '<img src=x onerror=alert(1)>' }} />
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('is what the generic outcome card renders for a run the gateway flags, never by name', () => {
    const { container, rerender } = render(
      <RunOutcomeCard isAgentRun result={DELIVERED} templateName="Agent Run" />
    );
    expect(container.textContent).toContain('Agent run outcome');
    rerender(<RunOutcomeCard result={DELIVERED} templateName="Agent Run" />);
    expect(container.textContent).not.toContain('Agent run outcome');
    expect(container.textContent).toContain('Review PR #7');
  });
});

describe('AgentRunFailureNote', () => {
  it('names the refusal and its code', () => {
    render(
      <AgentRunFailureNote
        failure={{
          code: 'AGENT_RUN_PUSH_POLICY',
          explanation: 'Nothing was pushed.',
          title: 'Refused by the push policy',
        }}
      />
    );
    expect(screen.getByText('Refused by the push policy')).toBeTruthy();
    expect(screen.getByText('AGENT_RUN_PUSH_POLICY')).toBeTruthy();
    expect(screen.getByRole('note')).toBeTruthy();
  });
});
