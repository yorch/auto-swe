// @vitest-environment jsdom

import type { AgentTraceRecord } from '@auto-swe/shared/types/api';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow/spec';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildTraceLinker, EMPTY_LINKER } from '@/lib/traceLinkage';
import { TracesTab } from './TracesTab';

// Nodes named after their step, as the existing cases assume.
const LINKER = buildTraceLinker(
  parseWorkflowSpec({
    entry: 'implement',
    name: 't',
    nodes: {
      implement: { next: 'review', step: 'implement', type: 'step' },
      review: { step: 'review', type: 'step' },
    },
    schemaVersion: SPEC_SCHEMA_VERSION,
  })
);

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
  recordingId: null,
  seq: 0,
  specNodeId: null,
  stepAttempt: null,
  toolName: null,
  trimmed: false,
  type: 'llm_response',
});

describe('TracesTab', () => {
  it('shows all traces when filterNodeId is null', () => {
    const traces = [makeTrace('implement'), makeTrace('review')];
    render(
      <TracesTab
        filterNodeId={null}
        linker={EMPTY_LINKER}
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
        filterNodeId="implement"
        linker={LINKER}
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
        compact
        filterNodeId="implement"
        linker={LINKER}
        onClearFilter={() => {}}
        traces={traces}
      />
    );
    expect(screen.queryByText(/Filtered to/)).toBeNull();
  });

  it('summarises Claude Code harness tool calls by path, command and pattern', () => {
    const call = (id: string, toolName: string, inputJson: Record<string, unknown>) => ({
      ...makeTrace('implement', id),
      inputJson,
      toolName,
      type: 'tool_call' as const,
    });
    render(
      <TracesTab
        filterNodeId={null}
        linker={EMPTY_LINKER}
        onClearFilter={() => {}}
        traces={[
          call('a', 'Bash', { command: 'yarn test --run' }),
          call('b', 'Read', { file_path: 'src/read-me.ts' }),
          call('c', 'Write', { content: 'x', file_path: 'src/written.ts' }),
          call('d', 'Edit', { file_path: 'src/edited.ts', new_string: 'b', old_string: 'a' }),
          call('e', 'Glob', { pattern: '**/*.tsx' }),
          call('f', 'Grep', { path: 'src', pattern: 'TODO' }),
        ]}
      />
    );
    expect(screen.getByText('yarn test --run')).toBeTruthy();
    expect(screen.getByText('src/read-me.ts')).toBeTruthy();
    expect(screen.getByText('src/written.ts')).toBeTruthy();
    expect(screen.getByText('src/edited.ts')).toBeTruthy();
    expect(screen.getByText('**/*.tsx')).toBeTruthy();
    expect(screen.getByText('TODO in src')).toBeTruthy();
  });
});

describe('TracesTab node linkage', () => {
  // `lintA` and `lintB` share a step; `fan` runs `impl` per branch.
  const linker = buildTraceLinker(
    parseWorkflowSpec({
      entry: 'lintA',
      name: 'linkage',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: { join: 'done', over: { literal: [1, 2] }, subgraph: 'impl', type: 'fanOut' },
        impl: { next: 'done', step: 'executeImplementation', type: 'step' },
        lintA: { next: 'lintB', step: 'runLint', type: 'step' },
        lintB: { next: 'fan', step: 'runLint', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    })
  );
  const rec = (
    id: string,
    nodeId: string,
    specNodeId: string,
    recordingId: string,
    extra: Partial<AgentTraceRecord> = {}
  ): AgentTraceRecord => ({
    ...makeTrace(nodeId, id),
    recordingId,
    specNodeId,
    stepAttempt: 1,
    ...extra,
  });
  const show = (filterNodeId: string | null, traces: AgentTraceRecord[]) =>
    render(
      <TracesTab
        filterNodeId={filterNodeId}
        linker={linker}
        onClearFilter={() => {}}
        traces={traces}
      />
    );

  it('shows only the selected node when two nodes share a step', () => {
    show('lintB', [rec('a', 'runLint', 'lintA', 'lintA'), rec('b', 'runLint', 'lintB', 'lintB')]);
    expect(screen.getAllByText('lintB').length).toBeGreaterThan(0);
    expect(screen.queryByText('lintA')).toBeNull();
  });

  const branchTraces = [
    rec('b0', 'executeImplementation', 'impl', 'fan[0]/impl'),
    rec('b1', 'executeImplementation', 'impl', 'fan[1]/impl'),
    rec('b1retry', 'executeImplementation', 'impl', 'fan[1]/impl', { stepAttempt: 2 }),
  ];

  it('groups a fan-out selection by branch, one section per branch', () => {
    show('fan', branchTraces);
    const headers = screen.getAllByTestId('trace-branch').map((el) => el.textContent);
    expect(headers).toEqual(['Branch fan[0]', 'Branch fan[1]']);
    // The retried execution of a branch is its own group.
    expect(screen.getAllByText('fan[1]/impl')).toHaveLength(2);
    expect(screen.getByText(/node attempt 2/)).toBeTruthy();
  });

  it('shows only that branch when a branch recording id is selected', () => {
    show('fan[1]/impl', branchTraces);
    expect(screen.getAllByTestId('trace-branch').map((el) => el.textContent)).toEqual([
      'Branch fan[1]',
    ]);
    expect(screen.queryByText('fan[0]/impl')).toBeNull();
  });

  it('shows every branch when the spec node itself is selected', () => {
    show('impl', branchTraces);
    expect(screen.getAllByTestId('trace-branch')).toHaveLength(2);
  });

  it('lists an old, ambiguous trace under every candidate node and labels it', () => {
    const old = makeTrace('runLint', 'old');
    const { unmount } = show('lintA', [old]);
    expect(screen.getAllByText('lintA | lintB').length).toBeGreaterThan(0);
    expect(screen.getByText('Ambiguous')).toBeTruthy();
    unmount();
    show('lintB', [old]);
    expect(screen.getByText('Ambiguous')).toBeTruthy();
  });

  it('does not label an old trace that maps to a single node', () => {
    show('impl', [makeTrace('executeImplementation', 'old-impl')]);
    expect(screen.queryByText('Ambiguous')).toBeNull();
  });

  it('flags an old trace as ambiguous when a branch is selected, since it cannot name one', () => {
    show('fan[0]/impl', [makeTrace('executeImplementation', 'old-impl')]);
    expect(screen.getByText('Ambiguous')).toBeTruthy();
  });

  it('describes the ambiguity in visible text the badge points at', () => {
    show('lintA', [makeTrace('runLint', 'old')]);
    const badge = screen.getByText('Ambiguous');
    const note = document.getElementById(badge.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toMatch(/matched by\s+activity name/);
  });

  it('flags untagged traces on a branch step row when the caller says so', () => {
    render(
      <TracesTab
        compact
        filterNodeId={null}
        linker={linker}
        onClearFilter={() => {}}
        traces={[makeTrace('executeImplementation', 'old-impl')]}
        untaggedAmbiguous
      />
    );
    expect(screen.getByText('Ambiguous')).toBeTruthy();
  });

  it('shows no branch headers for traces outside any fan-out', () => {
    show(null, [rec('a', 'runLint', 'lintA', 'lintA')]);
    expect(screen.queryByTestId('trace-branch')).toBeNull();
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
        filterNodeId={null}
        linker={EMPTY_LINKER}
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

    fireEvent.click(screen.getAllByRole('button', { name: /Request/ }).at(-1) as HTMLElement);

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

    expect(screen.getByText('Input')).toBeTruthy();
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

    expect(screen.getByText('Input')).toBeTruthy();
    const pres = [...document.querySelectorAll('pre')].map((el) => el.textContent);
    expect(pres).toEqual([JSON.stringify({ command }, null, 2), 'match']);
  });

  it('renders nothing for a trace with no error and no output', () => {
    expand({ ...makeTrace('implement'), type: 'activity_event' });

    expect(document.querySelector('pre')).toBeNull();
  });
});
