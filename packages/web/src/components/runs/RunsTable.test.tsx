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
  initiatedBy: { email: 'ada@example.com', id: 'u1', name: 'Ada Lovelace' },
  initiatedByService: null,
  outcomeDomain: null,
  outcomeType: null,
  rerunOfRunId: null,
  startedAt: '2026-01-01T00:00:00Z',
  status: 'SUCCESS',
  templateId: 't1',
  templateName: 'Ship a fix',
  templateVersion: 3,
  trigger: 'work-request',
  triggerRefId: null,
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
      'Initiated by',
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

  it('always shows the diagnostics link, so a mouse user can see the second destination', () => {
    render(<RunsTable runs={[RUN]} />);
    const action = screen.getByRole('link', { name: /diagnostics/i });
    expect(action.parentElement?.className ?? '').not.toContain('opacity-0');
    expect(action.getAttribute('tabindex')).not.toBe('-1');
  });

  it('shows a dash, not "Still running", for a finished run with no end time', () => {
    render(<RunsTable runs={[{ ...RUN, endedAt: null, status: 'FAILED' }]} />);
    expect(screen.queryByText('Still running')).toBeNull();
  });

  describe('initiated-by column', () => {
    it('shows a person by name with their email, and no trigger line for a plain work request', () => {
      render(<RunsTable runs={[RUN]} />);
      expect(screen.getByText('Ada Lovelace')).toBeTruthy();
      expect(screen.getByText('ada@example.com').getAttribute('title')).toBe('ada@example.com');
      expect(screen.queryByText('Work request')).toBeNull();
    });

    it('names the trigger under a person when it was a retry or a Slack launch', () => {
      render(<RunsTable runs={[{ ...RUN, trigger: 'work-request-retry' }]} />);
      expect(screen.getByText('via Re-run')).toBeTruthy();
    });

    it('shows a person with no name by their email alone', () => {
      render(
        <RunsTable
          runs={[{ ...RUN, initiatedBy: { email: 'ada@example.com', id: 'u1', name: null } }]}
        />
      );
      expect(screen.getAllByText('ada@example.com')).toHaveLength(1);
    });

    it('shows a service principal by name', () => {
      render(
        <RunsTable
          runs={[
            {
              ...RUN,
              initiatedBy: null,
              initiatedByService: { id: 's1', name: 'ci-bot' },
              trigger: 'service-token',
            },
          ]}
        />
      );
      expect(screen.getByText('ci-bot')).toBeTruthy();
      expect(screen.getByText('Service principal')).toBeTruthy();
    });

    it('shows only the trigger kind for a schedule, never its opaque id', () => {
      render(
        <RunsTable
          runs={[
            {
              ...RUN,
              initiatedBy: null,
              trigger: 'schedule',
              triggerRefId: 'sched-opaque-123',
            },
          ]}
        />
      );
      expect(screen.getByText('Schedule')).toBeTruthy();
      expect(screen.queryByText(/sched-opaque-123/)).toBeNull();
    });

    it('says Not recorded when nothing was recorded', () => {
      render(<RunsTable runs={[{ ...RUN, initiatedBy: null, trigger: null }]} />);
      const cell = screen.getByText('Not recorded');
      expect(cell.getAttribute('title')).toContain('before initiators were tracked');
    });

    it('explains a schedule run in its title', () => {
      render(<RunsTable runs={[{ ...RUN, initiatedBy: null, trigger: 'schedule' }]} />);
      expect(screen.getByText('Schedule').getAttribute('title')).toContain('Run now');
    });

    it('shows the trigger of a run whose user was deleted, with a no-person title', () => {
      render(<RunsTable runs={[{ ...RUN, initiatedBy: null, trigger: 'slack' }]} />);
      expect(screen.getByText('Slack').getAttribute('title')).toBe(
        'No person is recorded for this run.'
      );
    });
  });
});
