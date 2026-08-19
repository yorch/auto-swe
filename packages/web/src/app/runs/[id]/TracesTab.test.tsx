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
 * and the tool_call fallback — that share one <pre> treatment but disagree on
 * border radius and error tint. `TracePre`/`TraceErrorBanner` collapse the
 * markup while keeping those three renderings, so these pin the renderings.
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

  it('renders an llm_response Response body at 2px and truncates past the cap', () => {
    expand({
      ...makeTrace('implement'),
      inputJson: { systemPrompt: 'you are an implementer' },
      outputJson: { text: 'x'.repeat(3100) },
    });

    const pre = document.querySelector('pre') as HTMLPreElement;
    expect(pre.style.borderRadius).toBe('2px');
    expect(pre.textContent).toBe(`${'x'.repeat(3000)}\n…`);
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

  it('falls back to the 6px body when an llm_response carries no systemPrompt', () => {
    expand({ ...makeTrace('implement'), outputJson: { text: 'raw' } });

    const pre = document.querySelector('pre') as HTMLPreElement;
    expect(pre.style.borderRadius).toBe('6px');
    expect(pre.textContent).toBe('raw');
  });

  // Known bug (reported, not fixed here): the row is itself a <button>, so a
  // click on the nested REQUEST toggle bubbles up and collapses the whole row
  // instead of opening the section. That makes the Request body — and the
  // TruncatedText inside it — unreachable from the rendered UI.
  it('collapses the row when the nested Request toggle is clicked', () => {
    expand({
      ...makeTrace('implement'),
      inputJson: { systemPrompt: 'you are an implementer' },
      outputJson: { text: 'ok' },
    });
    expect(document.querySelector('pre')).not.toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: /REQUEST/ }).at(-1) as HTMLElement);

    expect(document.querySelector('pre')).toBeNull();
  });

  it('tints an activity_event error with the oklch banner at 2px', () => {
    expand({
      ...makeTrace('implement'),
      error: 'activity blew up',
      outputJson: { text: 'partial' },
      type: 'activity_event',
    });

    const banner = screen.getByText('activity blew up');
    expect(banner.style.borderRadius).toBe('2px');
    expect(banner.style.background).toContain('oklch');
  });

  it('tints a tool_call error with the brick banner at 6px', () => {
    expand({
      ...makeTrace('implement'),
      error: 'tool blew up',
      outputJson: { text: 'stderr' },
      toolName: 'bash',
      type: 'tool_call',
    });

    const banner = screen.getByText('tool blew up');
    expect(banner.style.borderRadius).toBe('6px');
    expect(banner.style.background).toContain('rgba(255, 122, 122');
    expect((document.querySelector('pre') as HTMLPreElement).style.borderRadius).toBe('6px');
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

  it('renders nothing for a trace with no error and no output', () => {
    expand({ ...makeTrace('implement'), type: 'activity_event' });

    expect(document.querySelector('pre')).toBeNull();
  });
});
