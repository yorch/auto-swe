// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunOutcomeCard } from './RunOutcomeCard';

describe('RunOutcomeCard', () => {
  it('renders nothing for an unknown template', () => {
    const { container } = render(
      <RunOutcomeCard result={{ text: 'hello' }} templateName="custom" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a Notion outcome with page link', () => {
    render(
      <RunOutcomeCard
        result={{ targetPageId: 'page-123', text: 'Draft content' }}
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
        templateName="product-prd-draft"
      />
    );
    expect(screen.getByText(/PRD body text/)).toBeTruthy();
  });

  it('renders a Slack outcome with channel and posted status', () => {
    render(
      <RunOutcomeCard
        result={{ channelId: 'C123', posted: true, text: 'Hello channel' }}
        templateName="send-slack-update"
      />
    );
    expect(screen.getByText(/#C123/)).toBeTruthy();
    expect(screen.getByText(/posted/)).toBeTruthy();
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
        templateName="create-issue"
      />
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://linear.app/issue/TEAM-1');
    expect(screen.getByText(/Something is broken/)).toBeTruthy();
  });
});
