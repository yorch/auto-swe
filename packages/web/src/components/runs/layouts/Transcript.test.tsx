// @vitest-environment jsdom

import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow/spec';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildTraceLinker } from '@/lib/traceLinkage';
import { Transcript } from './Transcript';

vi.mock('@/components/runs/RunMetaRail', () => ({ RunMetaRail: () => null }));

const spec = parseWorkflowSpec({
  entry: 'impl',
  name: 'jump',
  nodes: {
    done: { status: 'SUCCESS', type: 'terminate' },
    impl: { next: 'done', step: 'executeImplementation', type: 'step' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
});

const failed: WorkflowStepRecord = {
  attempt: 1,
  endedAt: null,
  error: 'boom',
  id: 's0',
  inputs: null,
  nodeId: 'impl',
  outputs: null,
  startedAt: null,
  status: 'FAILED',
};

const run = {
  status: 'FAILED',
  steps: [failed],
  templateName: 'T',
  templateVersion: 1,
  workRequest: null,
} as unknown as WorkflowRunDetail;

describe('Transcript jump to failure', () => {
  it('scrolls again when the same step is jumped to a second time', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const props = {
      dagOverlay: undefined,
      linker: buildTraceLinker(spec),
      run,
      selectedNodeId: 'impl',
      setSelectedNodeId: vi.fn(),
      spec,
      traces: [],
    };
    const { rerender } = render(<Transcript {...props} jumpNonce={1} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    rerender(<Transcript {...props} jumpNonce={2} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
