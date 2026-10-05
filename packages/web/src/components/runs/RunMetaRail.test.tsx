// @vitest-environment jsdom

import type { WorkflowRunDetail } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunMetaRail } from './RunMetaRail';

vi.mock('@/hooks/useTemporalUi', () => ({ useTemporalWorkflowUrl: () => null }));
vi.mock('./EvalSignalsPanel', () => ({ EvalSignalsPanel: () => null }));
vi.mock('./AutonomyDecisionsPanel', () => ({ AutonomyDecisionsPanel: () => null }));

const run = {
  costUsdAccrued: 1.5,
  endedAt: '2026-10-01T12:08:00Z',
  id: 'run-1',
  isAgentRun: false,
  startedAt: '2026-10-01T12:00:00Z',
  templateId: 't1',
  templateName: 'Fan-out',
  tokensInputTotal: 1000,
  tokensOutputTotal: 500,
  traces: [],
  workflowId: 'wf-1',
  workRequest: { description: 'Fix it', externalTicketId: 'T-1', id: 'wr-1' },
} as unknown as WorkflowRunDetail;

afterEach(cleanup);

describe('RunMetaRail beside the console (desktop)', () => {
  it('is the 270px column with its details always showing and no toggle', () => {
    render(<RunMetaRail run={run} />);
    expect(screen.queryByRole('button')).toBeNull();
    const aside = screen.getByText('Run details').closest('aside');
    expect(aside?.className).toContain('w-[270px]');
    expect(screen.getByText('Fix it')).toBeTruthy();
  });
});

describe('RunMetaRail collapsed under the graph (phone)', () => {
  it('starts closed behind a toggle that names what is inside', () => {
    render(<RunMetaRail collapsible run={run} />);
    const toggle = screen.getByRole('button', { name: /run details/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('8m');
    expect(toggle.textContent).toContain('$1.50');
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    expect(panel?.hidden).toBe(true);
  });

  it('opens and closes the panel it controls, keeping aria-expanded in step', () => {
    render(<RunMetaRail collapsible run={run} />);
    const toggle = screen.getByRole('button', { name: /run details/i });
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.hidden).toBe(false);
    expect(screen.getByText('Fix it')).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel?.hidden).toBe(true);
  });

  it('is a labelled landmark and a touch-sized control', () => {
    render(<RunMetaRail collapsible run={run} />);
    expect(screen.getByRole('complementary', { name: 'Run details' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /run details/i }).className).toContain(
      'min-h-[44px]'
    );
  });
});
