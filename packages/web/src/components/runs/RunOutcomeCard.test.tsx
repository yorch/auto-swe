// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunOutcomeCard } from './RunOutcomeCard';

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
