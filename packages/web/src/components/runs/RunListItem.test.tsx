// @vitest-environment jsdom

import type { WorkflowRunSummary } from '@auto-swe/shared/types/api';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunListItem } from './RunListItem';

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

describe('RunListItem', () => {
  it('opens the request panel first and offers diagnostics second', () => {
    render(<RunListItem run={RUN} />);
    expect(screen.getByRole('link', { name: 'Fix login' }).getAttribute('href')).toBe(
      '/workflows?request=wr-1'
    );
    expect(screen.getByRole('link', { name: /diagnostics/i }).getAttribute('href')).toBe(
      '/runs/run-1'
    );
  });

  it('goes straight to diagnostics when the run has no request', () => {
    render(<RunListItem run={{ ...RUN, workRequest: null }} />);
    expect(screen.getByRole('link', { name: 'Ship a fix' }).getAttribute('href')).toBe(
      '/runs/run-1'
    );
  });
});
