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
});
