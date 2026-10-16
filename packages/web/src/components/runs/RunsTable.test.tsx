// @vitest-environment jsdom

import type { WorkflowRunSummary } from '@auto-swe/shared/types/api';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunsTable } from './RunsTable';

const RUN: WorkflowRunSummary = {
  costUsdAccrued: 1.5,
  domain: null,
  endedAt: '2026-01-01T00:05:00Z',
  id: 'run-1',
  outcomeDomain: null,
  outcomeType: null,
  startedAt: '2026-01-01T00:00:00Z',
  status: 'SUCCESS',
  templateId: 't1',
  templateName: 'Ship a fix',
  templateVersion: 3,
  workflowId: 'wf-1',
  workRequest: { description: 'Fix login', externalTicketId: 'JIRA-1', id: 'wr-1' },
};

describe('RunsTable', () => {
  it('shows status, title, workflow, duration, cost and start in one order', () => {
    render(<RunsTable runs={[RUN]} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual([
      'Status',
      'Title',
      'Workflow',
      'Duration',
      'Cost',
      'Started',
      'Diagnostics',
    ]);
    expect(screen.getByText('JIRA-1')).toBeTruthy();
    expect(screen.getByText('Ship a fix')).toBeTruthy();
    expect(screen.getByText('v3')).toBeTruthy();
    expect(screen.getByText('5m')).toBeTruthy();
    expect(screen.getByText('$1.50')).toBeTruthy();
  });

  it('opens the request panel first and offers diagnostics second', () => {
    render(<RunsTable runs={[RUN]} />);
    expect(screen.getByRole('link', { name: 'Fix login' }).getAttribute('href')).toBe(
      '/requests?request=wr-1'
    );
    expect(screen.getByRole('link', { name: /diagnostics/i }).getAttribute('href')).toBe(
      '/runs/run-1'
    );
  });

  it('goes straight to diagnostics when the run has no request', () => {
    render(<RunsTable runs={[{ ...RUN, workRequest: null }]} />);
    expect(screen.getByRole('link', { name: 'Ship a fix' }).getAttribute('href')).toBe(
      '/runs/run-1'
    );
  });

  it('shows a running run as still running with no cost yet', () => {
    render(<RunsTable runs={[{ ...RUN, endedAt: null, status: 'RUNNING' }]} />);
    expect(screen.getByText('Still running')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('reveals the repeated diagnostics action on hover or focus, without leaving the tab order', () => {
    render(<RunsTable runs={[RUN]} />);
    const action = screen.getByRole('link', { name: /diagnostics/i });
    const reveal = action.parentElement?.className ?? '';
    expect(reveal).toContain('opacity-0');
    expect(reveal).toContain('group-hover:opacity-100');
    expect(reveal).toContain('group-focus-within:opacity-100');
    expect(reveal).toContain('[@media(hover:none)]:opacity-100');
    expect(reveal).not.toMatch(/\b(hidden|invisible)\b/);
    expect(action.getAttribute('tabindex')).not.toBe('-1');
    expect(action.closest('tr')?.className).toContain('group');
  });
});
