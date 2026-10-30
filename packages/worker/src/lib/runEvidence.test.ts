import { beforeEach, describe, expect, it, vi } from 'vitest';

const activity = vi.hoisted(() => ({ currentWorkflowRunId: vi.fn() }));
const node = vi.hoisted(() => ({ currentNodeTag: vi.fn() }));
const recordRunEvidence = vi.hoisted(() => vi.fn());

vi.mock('./activityContext.js', () => activity);
vi.mock('./activityNodeTag.js', () => node);
vi.mock('@auto-swe/shared/lib/runEvidence', () => ({ recordRunEvidence }));

import { recordActivityEvidence } from './runEvidence.js';

describe('recordActivityEvidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activity.currentWorkflowRunId.mockResolvedValue('run-1');
    node.currentNodeTag.mockReturnValue({ specNodeId: 'node-1', stepAttempt: 2 });
    recordRunEvidence.mockResolvedValue({
      artifactId: 'artifact-1',
      evidenceId: 'evidence-1',
      ok: true,
    });
  });

  it('attributes evidence to the activity node and emits a trace event', async () => {
    const tracer = { addActivityEvent: vi.fn() };
    const input = {
      body: 'log',
      caption: 'Home page',
      contentType: 'text/plain; charset=utf-8',
      kind: 'log' as const,
      pageUrl: 'http://localhost:3000',
      source: 'uiVerify' as const,
    };

    await expect(recordActivityEvidence(input, tracer as never)).resolves.toMatchObject({
      evidenceId: 'evidence-1',
      ok: true,
    });
    expect(recordRunEvidence).toHaveBeenCalledWith({
      ...input,
      runId: 'run-1',
      specNodeId: 'node-1',
      stepAttempt: 2,
    });
    expect(tracer.addActivityEvent).toHaveBeenCalledWith({
      name: 'ui.evidence',
      outputJson: {
        caption: 'Home page',
        evidenceId: 'evidence-1',
        kind: 'log',
        pageUrl: 'http://localhost:3000',
      },
    });
  });

  it('does not emit trace records when evidence is rejected', async () => {
    recordRunEvidence.mockResolvedValue({ ok: false, reason: 'run_cap' });
    const tracer = { addActivityEvent: vi.fn() };
    await recordActivityEvidence(
      {
        body: 'log',
        contentType: 'text/plain; charset=utf-8',
        kind: 'log',
        source: 'agent',
      },
      tracer as never
    );
    expect(tracer.addActivityEvent).not.toHaveBeenCalled();
  });
});
