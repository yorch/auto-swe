// @vitest-environment jsdom

import type { EpicSummary } from '@auto-swe/shared/types/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EpicList } from './EpicList';

afterEach(cleanup);

const epic = (over: Partial<EpicSummary> = {}): EpicSummary => ({
  createdAt: new Date().toISOString(),
  description: 'Roll the rename across services',
  epicWorkflowId: 'epic-acme/1',
  externalTicketId: 'JIRA-7',
  repoCount: 3,
  requestedBy: { email: 'dev@acme.test', id: 'u1', name: null },
  status: 'RUNNING',
  updatedAt: null,
  workRequestId: 'wr-7',
  ...over,
});

describe('EpicList', () => {
  it('links the epic title to its page and shows the brief under it', () => {
    render(<EpicList epics={[epic()]} />);
    const link = screen.getByRole('link', { name: 'JIRA-7' });
    expect(link.getAttribute('href')).toBe('/epics/epic-acme%2F1');
    expect(screen.getByText('Roll the rename across services')).toBeTruthy();
    expect(screen.getByRole('table', { name: /Multi-repository epics/ })).toBeTruthy();
  });

  it('falls back to the requester email and a dash when nobody asked', () => {
    render(<EpicList epics={[epic(), epic({ requestedBy: null, workRequestId: 'wr-8' })]} />);
    expect(screen.getByText('dev@acme.test')).toBeTruthy();
    expect(screen.getAllByText('—')).toHaveLength(1);
  });
});
