// @vitest-environment jsdom

import type { AgentTraceRecord } from '@auto-swe/shared/types/api';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TracesTab } from './TracesTab';

const makeTrace = (nodeId: string, id = nodeId): AgentTraceRecord => ({
  agentKey: 'implementer',
  attempt: 1,
  costUsd: null,
  createdAt: '2026-01-01T00:00:00Z',
  durationMs: 100,
  error: null,
  id,
  inputJson: null,
  inputTokens: null,
  model: null,
  nodeId,
  otelSpanId: null,
  otelTraceId: null,
  outputJson: null,
  outputTokens: null,
  seq: 0,
  toolName: null,
  trimmed: false,
  type: 'llm_response',
});

describe('TracesTab', () => {
  it('shows all traces when filterNodeId is null', () => {
    const traces = [makeTrace('implement'), makeTrace('review')];
    render(
      <TracesTab
        activityToNodeId={{}}
        filterNodeId={null}
        onClearFilter={() => {}}
        traces={traces}
      />
    );
    // Group headers display the activityName (nodeId) when no dagNodeId mapping exists
    expect(screen.getAllByText('implement').length).toBeGreaterThan(0);
    expect(screen.getAllByText('review').length).toBeGreaterThan(0);
  });

  it('shows only matching traces when filterNodeId is set', () => {
    const traces = [makeTrace('implement'), makeTrace('review')];
    render(
      <TracesTab
        activityToNodeId={{ implement: 'implement', review: 'review' }}
        filterNodeId="implement"
        onClearFilter={() => {}}
        traces={traces}
      />
    );
    // "implement" appears in the filter banner and the group header
    expect(screen.getAllByText('implement').length).toBeGreaterThan(0);
    expect(screen.queryByText('review')).toBeNull();
  });

  it('hides the filter banner when compact=true', () => {
    const traces = [makeTrace('implement')];
    render(
      <TracesTab
        activityToNodeId={{ implement: 'implement' }}
        compact
        filterNodeId="implement"
        onClearFilter={() => {}}
        traces={traces}
      />
    );
    expect(screen.queryByText(/Filtered to/)).toBeNull();
  });
});

/**
 * TraceOutput renders three different bodies — llm_response, activity_event
 * and the tool_call fallback. They share one <pre> treatment (`TracePre`) and
 * one error banner (`TraceErrorBanner`, an error `Alert`); these pin that every
 * branch renders through them.
 */
describe('TraceOutput', () => {
  function expand(trace: AgentTraceRecord) {
    render(
      <TracesTab
        activityToNodeId={{}}
        filterNodeId={null}
        onClearFilter={() => {}}
        traces={[trace]}
      />
    );
    fireEvent.click(screen.getAllByRole('button')[0]);
  }

  it('renders an llm_response Response body and truncates past the cap', () => {
    // Distinct head and tail markers so a head-only cut is visibly wrong: a
    // truncated body's conclusion is at the end, so the cap keeps both ends.
    expand({
      ...makeTrace('implement'),
      inputJson: { systemPrompt: 'you are an implementer' },
      outputJson: { text: `HEAD${'x'.repeat(3100)}TAIL` },
    });

    const pre = document.querySelector('pre') as HTMLPreElement;
    expect(pre.className).toContain('bg-ink-900');
    expect(pre.textContent).toMatch(/^HEADx+\n… \d+ characters hidden …\nx+TAIL$/);
    expect((pre.textContent ?? '').length).toBeLessThan(3100);
  });

  it('leaves an under-cap body uncut', () => {
    expand({
      ...makeTrace('implement'),
      inputJson: { systemPrompt: 'you are an implementer' },
      outputJson: { text: 'short output' },
    });

    const pres = [...document.querySelectorAll('pre')].map((el) => el.textContent);
    expect(pres).toContain('short output');
  });

  it('falls back to the plain body when an llm_response carries no systemPrompt', () => {
    expand({ ...makeTrace('implement'), outputJson: { text: 'raw' } });

    const pre = document.querySelector('pre') as HTMLPreElement;
    expect(pre.className).toContain('bg-ink-900');
    expect(pre.textContent).toBe('raw');
  });

  it('does not collapse the row when a nested Request toggle is clicked', () => {
    expand({
      ...makeTrace('implement'),
      inputJson: { systemPrompt: 'you are an implementer' },
      outputJson: { text: 'ok' },
    });
    expect(document.querySelector('pre')).not.toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: /REQUEST/ }).at(-1) as HTMLElement);

    // The row should stay expanded; the Request section is inside a container
    // that stops propagation so the row toggle is not affected.
    expect(document.querySelector('pre')).not.toBeNull();
  });

  it('renders an activity_event error in the error alert', () => {
    expand({
      ...makeTrace('implement'),
      error: 'activity blew up',
      outputJson: { text: 'partial' },
      type: 'activity_event',
    });

    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('activity blew up');
    expect(banner.className).toContain('text-brick-400');
  });

  it('renders a tool_call error in the same error alert', () => {
    expand({
      ...makeTrace('implement'),
      error: 'tool blew up',
      outputJson: { text: 'stderr' },
      toolName: 'bash',
      type: 'tool_call',
    });

    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('tool blew up');
    expect(banner.className).toContain('text-brick-400');
    expect((document.querySelector('pre') as HTMLPreElement).textContent).toBe('stderr');
  });

  it('renders both the INPUT and the output block for an activity_event', () => {
    expand({
      ...makeTrace('implement'),
      inputJson: { attempt: 2 },
      outputJson: { text: 'done' },
      type: 'activity_event',
    });

    expect(screen.getByText('INPUT')).toBeTruthy();
    const pres = [...document.querySelectorAll('pre')].map((el) => el.textContent);
    expect(pres).toEqual([JSON.stringify({ attempt: 2 }, null, 2), 'done']);
  });

  it('expands a capped body to its full text on demand', () => {
    const full = `HEAD${'x'.repeat(3100)}TAIL`;
    expand({
      ...makeTrace('implement'),
      inputJson: { systemPrompt: 'you are an implementer' },
      outputJson: { text: full },
    });

    fireEvent.click(screen.getByRole('button', { name: /show all/ }));

    expect(document.querySelector('pre')?.textContent).toBe(full);
    // The row stays open: the toggle stops propagation like the other nested controls.
    fireEvent.click(screen.getByRole('button', { name: /show less/ }));
    expect(document.querySelector('pre')?.textContent).toMatch(/characters hidden/);
  });

  it("shows a tool_call's input, not just its output", () => {
    const command = `grep -rn ${'needle '.repeat(20)}src`;
    expand({
      ...makeTrace('implement'),
      inputJson: { command },
      outputJson: { output: 'match' },
      toolName: 'bash',
      type: 'tool_call',
    });

    expect(screen.getByText('INPUT')).toBeTruthy();
    const pres = [...document.querySelectorAll('pre')].map((el) => el.textContent);
    expect(pres).toEqual([JSON.stringify({ command }, null, 2), 'match']);
  });

  it('renders nothing for a trace with no error and no output', () => {
    expand({ ...makeTrace('implement'), type: 'activity_event' });

    expect(document.querySelector('pre')).toBeNull();
  });
});
