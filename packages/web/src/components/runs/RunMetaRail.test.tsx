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
  initiatedBy: null,
  initiatedByService: null,
  isAgentRun: false,
  rerunOfRunId: null,
  startedAt: '2026-10-01T12:00:00Z',
  templateId: 't1',
  templateName: 'Fan-out',
  tokensInputTotal: 1000,
  tokensOutputTotal: 500,
  traces: [],
  trigger: null,
  triggerRefId: null,
  workflowId: 'wf-1',
  workRequest: { description: 'Fix it', externalTicketId: 'T-1', id: 'wr-1' },
} as unknown as WorkflowRunDetail;

afterEach(cleanup);

describe('RunMetaRail beside the console (desktop)', () => {
  it('is the 270px column with its details always showing and no toggle', () => {
    render(<RunMetaRail run={run} />);
    expect(screen.queryByRole('button', { name: /run details/i })).toBeNull();
    const aside = screen.getByText('Run details').closest('aside');
    expect(aside?.className).toContain('w-[270px]');
    expect(screen.getByText('Fix it')).toBeTruthy();
  });
});

describe('RunMetaRail identifiers and trace count', () => {
  it('shows the run id and workflow id, each with a copy button', () => {
    render(<RunMetaRail run={run} />);
    expect(screen.getByText('run-1')).toBeTruthy();
    expect(screen.getByText('wf-1')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /copy/i })).toHaveLength(2);
  });

  it('says the trace count is the latest window when the run was truncated', () => {
    const long = { ...run, traces: new Array(3).fill({}), tracesTruncated: true };
    render(<RunMetaRail run={long as unknown as WorkflowRunDetail} />);
    expect(screen.getByText('3 (latest only)')).toBeTruthy();
  });
});

describe('RunMetaRail provenance', () => {
  it('shows the person, their email, the trigger and a link to the run it re-ran', () => {
    const rerun = {
      ...run,
      initiatedBy: { email: 'ada@example.com', id: 'u1', name: 'Ada Lovelace' },
      rerunOfRunId: 'run-0',
      trigger: 'template-retry',
      triggerRefId: 'opaque-ref',
    } as unknown as WorkflowRunDetail;
    render(<RunMetaRail run={rerun} />);
    expect(screen.getByText('Initiated by')).toBeTruthy();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(screen.getByText('Trigger')).toBeTruthy();
    expect(screen.getByText('Re-run')).toBeTruthy();
    expect(screen.getByText('Previous attempt')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View' }).getAttribute('href')).toBe('/runs/run-0');
    expect(screen.queryByText(/opaque-ref/)).toBeNull();
  });

  it('omits Trigger and Previous attempt when not recorded, and says Not recorded', () => {
    render(<RunMetaRail run={run} />);
    expect(screen.getByText('Initiated by')).toBeTruthy();
    expect(screen.getByText('Not recorded')).toBeTruthy();
    expect(screen.queryByText('Trigger')).toBeNull();
    expect(screen.queryByText('Previous attempt')).toBeNull();
  });

  it('hides the separate Trigger row for a system run, which Initiated by already says', () => {
    render(<RunMetaRail run={{ ...run, trigger: 'schedule' } as unknown as WorkflowRunDetail} />);
    expect(screen.getByText('Schedule').getAttribute('title')).toContain('Run now');
    expect(screen.queryByText('Trigger')).toBeNull();
  });

  it('keeps the Trigger row for a service principal and labels it', () => {
    render(
      <RunMetaRail
        run={
          {
            ...run,
            initiatedByService: { id: 's1', name: 'ci-bot' },
            trigger: 'service-token',
          } as unknown as WorkflowRunDetail
        }
      />
    );
    expect(screen.getByText('Service principal')).toBeTruthy();
    expect(screen.getByText('Trigger')).toBeTruthy();
    expect(screen.getByText('API token')).toBeTruthy();
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

  it('names the section once: the toggle says it, the panel does not repeat it', () => {
    render(<RunMetaRail collapsible run={run} />);
    expect(screen.getAllByText('Run details')).toHaveLength(1);
  });

  it('is a landmark with a touch-sized control', () => {
    render(<RunMetaRail collapsible run={run} />);
    expect(screen.getByRole('complementary')).toBeTruthy();
    expect(screen.getByRole('button', { name: /run details/i }).className).toContain(
      'min-h-[44px]'
    );
  });
});
