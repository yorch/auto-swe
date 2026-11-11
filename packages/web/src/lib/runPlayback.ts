import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { isTerminalWorkflowRunStatus } from '@auto-swe/shared/types/api';

function epoch(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function runTimeWindow(
  run: Omit<
    Pick<WorkflowRunDetail, 'startedAt' | 'endedAt' | 'status' | 'steps' | 'traces'>,
    'startedAt'
  > & { startedAt: string | null },
  now: number,
  followLive = true
) {
  const recorded = [
    ...run.steps.flatMap((s) => [epoch(s.startedAt), epoch(s.endedAt)]),
    ...(run.traces ?? []).map((t) => epoch(t.createdAt)),
  ].filter((v): v is number => v !== null);
  const first = recorded.reduce((a, b) => Math.min(a, b), now);
  const start = epoch(run.startedAt) ?? first;
  const live = followLive && !isTerminalWorkflowRunStatus(run.status);
  const last = recorded.reduce((a, b) => Math.max(a, b), start);
  const end = epoch(run.endedAt) ?? (live ? Math.max(now, last) : last);
  return { duration: Math.max(0, end - start), live, start };
}

/** Historical rows never reveal the outcome, output, or error of a future completion. */
export function stepsAtTime(steps: WorkflowStepRecord[], cutoff: number): WorkflowStepRecord[] {
  return steps.map((step) => {
    const start = epoch(step.startedAt);
    const end = epoch(step.endedAt);
    if (end !== null && end <= cutoff) {
      return step;
    }
    const started = start !== null && start <= cutoff;
    return {
      ...step,
      endedAt: null,
      error: null,
      inputs: started ? step.inputs : null,
      outputs: null,
      startedAt: started ? step.startedAt : null,
      status: started ? 'RUNNING' : 'PENDING',
    };
  });
}
