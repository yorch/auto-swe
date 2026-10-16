// @vitest-environment jsdom

import type { WorkspaceRequestSummary } from '@auto-swe/shared/types/api';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RequestList } from './RequestList';

const REQUEST: WorkspaceRequestSummary = {
  attemptCount: 2,
  costUsdAccrued: 0.4,
  domain: null,
  endedAt: '2026-01-01T00:05:00Z',
  failedExecutionCount: 0,
  id: 'run-1',
  isCrossRepo: false,
  outcomeDomain: null,
  outcomeType: null,
  pendingStepCount: 1,
  reviewUrl: 'https://example.test/pr/1',
  stage: null,
  startedAt: '2026-01-01T00:00:00Z',
  status: 'RUNNING',
  target: 'acme/payments',
  templateId: 't1',
  templateName: 'Ship a fix',
  templateVersion: 1,
  visibleExecutionCount: 2,
  workflowId: 'wf-1',
  workRequest: { description: 'Fix login', externalTicketId: 'JIRA-1', id: 'wr-1' },
};

describe('RequestList', () => {
  it('uses the run history column order', () => {
    render(<RequestList requests={[REQUEST]} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual([
      'Status',
      'Title',
      'Workflow',
      'Duration',
      'Cost',
      'Updated',
      'Review',
    ]);
  });

  it('keeps ticket, progress, attention, target, attempts and the review link', () => {
    render(<RequestList requests={[REQUEST]} />);
    expect(screen.getByRole('link', { name: 'Fix login' }).getAttribute('href')).toBe(
      '/requests?request=wr-1'
    );
    expect(screen.getByText('JIRA-1')).toBeTruthy();
    expect(screen.getByText('Waiting for a response')).toBeTruthy();
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByText('acme/payments')).toBeTruthy();
    expect(screen.getByText('2 attempts')).toBeTruthy();
    const review = screen.getByRole('link', { name: /Review pull request/ });
    expect(review.getAttribute('href')).toBe('https://example.test/pr/1');
    expect(review.parentElement?.className).not.toContain('opacity-0');
  });

  it('builds each row link with hrefFor', () => {
    render(<RequestList hrefFor={(id) => `/x?request=${id}`} requests={[REQUEST]} />);
    expect(screen.getByRole('link', { name: 'Fix login' }).getAttribute('href')).toBe(
      '/x?request=wr-1'
    );
  });

  it('tightens the rows in compact density', () => {
    render(<RequestList density="compact" requests={[REQUEST]} />);
    expect(screen.getByText('Ship a fix').closest('td')?.className).toContain('py-2');
  });
});
