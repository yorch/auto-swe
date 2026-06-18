// @vitest-environment jsdom

import type { AgentTraceRecord } from '@auto-swe/shared/types/api';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TracesTab } from './TracesTab';

const makeTrace = (nodeId: string, id = nodeId): AgentTraceRecord => ({
  agentKey: 'implementer',
  attempt: 1,
  createdAt: '2026-01-01T00:00:00Z',
  durationMs: 100,
  error: null,
  id,
  inputJson: null,
  nodeId,
  outputJson: null,
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
