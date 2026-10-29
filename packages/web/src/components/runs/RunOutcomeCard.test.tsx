// @vitest-environment jsdom

import { TICKET_FAILURE_CLASSES } from '@auto-swe/shared/lib/integrations/ticketFailure';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunOutcomeCard, TICKET_UNAVAILABLE_LINES } from './RunOutcomeCard';

describe('RunOutcomeCard', () => {
  it('renders nothing for an unknown template', () => {
    const { container } = render(
      <RunOutcomeCard result={{ text: 'hello' }} runId="run-1" templateName="custom" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a Notion outcome with page link', () => {
    render(
      <RunOutcomeCard
        result={{ targetPageId: 'page-123', text: 'Draft content' }}
        runId="run-1"
        templateName="notion-content-draft"
      />
    );
    expect(screen.getByText(/Draft content/)).toBeTruthy();
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://notion.so/page-123');
  });

  it('renders a product PRD outcome with page link', () => {
    render(
      <RunOutcomeCard
        result={{ targetPageId: 'page-456', text: 'PRD body text' }}
        runId="run-1"
        templateName="product-prd-draft"
      />
    );
    expect(screen.getByText(/PRD body text/)).toBeTruthy();
  });

  it('renders a Slack outcome with channel and posted status', () => {
    render(
      <RunOutcomeCard
        result={{ channelId: 'C123', posted: true, text: 'Hello channel' }}
        runId="run-1"
        templateName="send-slack-update"
      />
    );
    expect(screen.getByText(/#C123/)).toBeTruthy();
    expect(screen.getByText('Posted')).toBeTruthy();
    expect(screen.getByText(/Hello channel/)).toBeTruthy();
  });

  it('renders an issue tracker outcome with issue link', () => {
    render(
      <RunOutcomeCard
        result={{
          description: 'Something is broken',
          issueUrl: 'https://linear.app/issue/TEAM-1',
          title: 'Bug',
        }}
        runId="run-1"
        templateName="create-issue"
      />
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://linear.app/issue/TEAM-1');
    expect(screen.getByText(/Something is broken/)).toBeTruthy();
  });

  it('renders an issue tracker outcome for the from-brief template', () => {
    render(
      <RunOutcomeCard
        result={{
          description: 'Drafted from brief',
          issueUrl: 'https://x.atlassian.net/browse/PROJ-9',
          title: 'Refactor auth',
        }}
        runId="run-1"
        templateName="create-issue-from-brief"
      />
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://x.atlassian.net/browse/PROJ-9');
    expect(screen.getByText(/Drafted from brief/)).toBeTruthy();
  });

  it('does not render a malicious issueUrl as a link', () => {
    const { container } = render(
      <RunOutcomeCard
        result={{
          description: 'Should not be clickable',
          issueUrl: 'javascript:alert(1)',
          title: 'Evil',
        }}
        runId="run-1"
        templateName="create-issue"
      />
    );
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText(/Should not be clickable/)).toBeTruthy();
  });
});

describe('a spilled result text', () => {
  it('offers the full text where a template shows its text output', () => {
    const id = '7a9619ff-8b86-4a08-8b86-3e6f9619ffd2';
    render(
      <RunOutcomeCard
        result={{ text: `[stored as artifact ${id} — 9000 bytes]`, ticketId: 'Z-1' }}
        runId="run-1"
        templateName="zendesk-ticket-reply"
      />
    );
    expect(screen.getByRole('button', { name: 'View full text (9,000 bytes)' })).toBeTruthy();
  });

  describe('a run that stopped with a message', () => {
    it('shows the message of any template, and no more than that when there are no ambiguities', () => {
      const { container } = render(
        <RunOutcomeCard
          result={{ message: 'The request is not actionable: paste the ticket text.' }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      expect(screen.getByText(/The request is not actionable/)).toBeTruthy();
      expect(container.querySelector('ul')).toBeNull();
    });

    it('is drawn in the warning tone, not the success one other cards use', () => {
      const { container } = render(
        <RunOutcomeCard result={{ message: 'Stopped.' }} runId="run-1" templateName="x" />
      );
      const icon = container.querySelector('h3 svg');
      expect(icon?.getAttribute('class')).toContain('text-warning-400');
      expect(icon?.getAttribute('class')).not.toContain('text-success-400');
    });

    it('leaves the pull request card in the success tone', () => {
      const { container } = render(
        <RunOutcomeCard
          result={{ prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7' }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      const classes = container.querySelector('h3 svg')?.getAttribute('class');
      expect(classes).toContain('text-success-400');
      expect(classes).not.toContain('text-warning-400');
    });

    it('lists the ambiguities as plain text, not markup', () => {
      const { container } = render(
        <RunOutcomeCard
          result={{
            ambiguities: ['only a Jira URL', '<img src=x onerror=alert(1)>', 42],
            message: 'The request is not actionable.',
          }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      const items = [...container.querySelectorAll('li')].map((li) => li.textContent);
      expect(items).toEqual(['only a Jira URL', '<img src=x onerror=alert(1)>']);
      expect(container.querySelector('img')).toBeNull();
    });

    const LINES: Record<string, string> = {
      empty: 'The ticket was read from the tracker but has no text.',
      forbidden: 'The ticket could not be read from the tracker (access was refused).',
      network: 'The ticket could not be read from the tracker (the tracker could not be reached).',
      not_found:
        'The ticket could not be read from the tracker (access was refused, or it does not exist).',
      rate_limited:
        'The ticket could not be read from the tracker (the tracker is limiting requests).',
      redirect:
        'The ticket could not be read from the tracker (the tracker address redirects, which is not followed).',
      refused:
        "The ticket could not be read from the tracker (it was blocked by the platform's network policy; ask an administrator to check the tracker's allowed addresses).",
      rejected:
        'The ticket could not be read from the tracker (it rejected the request — check the tracker credentials and ticket id).',
      server_error:
        'The ticket could not be read from the tracker (the tracker returned an error).',
      timeout:
        'The ticket could not be read from the tracker (the tracker did not answer in time).',
      unauthorized:
        'The ticket could not be read from the tracker (the tracker rejected its credentials).',
      unconfigured:
        'The ticket could not be read from the tracker (no ticket tracker is configured).',
      unknown: 'The ticket could not be read (the reason is not known).',
    };

    it('has a line for every failure class, and no line for anything else', () => {
      expect([...TICKET_UNAVAILABLE_LINES.keys()].sort()).toEqual(
        [...TICKET_FAILURE_CLASSES].sort()
      );
      expect(Object.keys(LINES).sort()).toEqual([...TICKET_FAILURE_CLASSES].sort());
    });

    it.each(Object.entries(LINES))('adds one neutral line for the class %s', (reason, line) => {
      render(
        <RunOutcomeCard
          result={{ message: 'The request is not actionable.', ticketUnavailableReason: reason }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      expect(screen.getByText(line).textContent).not.toMatch(/\byou\b|\byour\b/i);
    });

    it('does not blame the tracker for an unknown reason or a ticket that was read', () => {
      expect(LINES.unknown).not.toMatch(/from the tracker/);
      expect(LINES.empty).toMatch(/was read/);
    });

    it('adds no line when the reason is empty, absent or not a known class', () => {
      for (const ticketUnavailableReason of ['', undefined, 7, 'constructor', '<b>x</b>']) {
        const { container, unmount } = render(
          <RunOutcomeCard
            result={{ message: 'The request is not actionable.', ticketUnavailableReason }}
            runId="run-1"
            templateName="ticket-to-merge"
          />
        );
        expect(container.textContent).not.toMatch(/could not be read/);
        expect(container.querySelector('b')).toBeNull();
        unmount();
      }
    });

    it('never renders markup from the reason or the ambiguities as elements', () => {
      const payload = '<img src=x onerror=alert(1)>';
      const { container } = render(
        <RunOutcomeCard
          result={{
            ambiguities: [payload],
            message: 'The request is not actionable.',
            ticketUnavailableReason: payload,
          }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain(payload);
      expect(container.textContent).not.toMatch(/could not be read/);
    });

    it('still renders nothing for a result with neither a message nor a known shape', () => {
      const { container } = render(
        <RunOutcomeCard
          result={{ ambiguities: ['x'], text: 'hello' }}
          runId="run-1"
          templateName="ticket-to-merge"
        />
      );
      expect(container.firstChild).toBeNull();
    });
  });
});
