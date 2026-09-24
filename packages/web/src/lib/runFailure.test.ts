import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import { findFailedStep } from './runFailure';

function step(
  nodeId: string,
  attempt: number,
  status: WorkflowStepRecord['status'],
  endedAt: string
): WorkflowStepRecord {
  return {
    attempt,
    endedAt,
    error: status === 'FAILED' ? `${nodeId} failed` : null,
    id: `${nodeId}-${attempt}`,
    inputs: null,
    nodeId,
    outputs: null,
    startedAt: endedAt,
    status,
  };
}

describe('findFailedStep', () => {
  it('shows nothing for a run that did not fail, even with FAILED step records', () => {
    const steps = [step('lint', 1, 'FAILED', '2026-01-01T00:00:01Z')];
    expect(findFailedStep('SUCCESS', steps)).toBeNull();
    expect(findFailedStep('RUNNING', steps)).toBeNull();
  });

  it('ignores a node that failed and then recovered on retry', () => {
    const steps = [
      step('implement', 1, 'FAILED', '2026-01-01T00:00:01Z'),
      step('implement', 2, 'PASSED', '2026-01-01T00:00:02Z'),
      step('review', 1, 'FAILED', '2026-01-01T00:00:03Z'),
    ];
    expect(findFailedStep('FAILED', steps)?.nodeId).toBe('review');
  });

  it('returns the last attempt of the failing node', () => {
    const steps = [
      step('ci', 1, 'FAILED', '2026-01-01T00:00:01Z'),
      step('ci', 2, 'FAILED', '2026-01-01T00:00:05Z'),
    ];
    expect(findFailedStep('FAILED', steps)?.attempt).toBe(2);
  });

  it('prefers the node that failed last', () => {
    const steps = [
      step('warnOnly', 1, 'FAILED', '2026-01-01T00:00:01Z'),
      step('gate', 1, 'FAILED', '2026-01-01T00:00:09Z'),
    ];
    expect(findFailedStep('TIMED_OUT', steps)?.nodeId).toBe('gate');
  });
});
