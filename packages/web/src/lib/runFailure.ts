import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';

const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(['FAILED', 'TIMED_OUT']);

/**
 * The step to blame for a failed run, or null.
 *
 * Only a run that ended FAILED/TIMED_OUT has a failure to show — a SUCCESS run
 * can still hold FAILED step records (a retry that later passed, or a node
 * whose `onFail` is `warn`). Within a failed run, each node's latest attempt is
 * what counts: a node that failed and then passed on retry is not the cause.
 * Of the nodes whose latest attempt failed, the one that failed last is
 * returned, as its latest attempt.
 */
export function findFailedStep(
  runStatus: string,
  steps: readonly WorkflowStepRecord[]
): WorkflowStepRecord | null {
  if (!FAILED_RUN_STATUSES.has(runStatus)) {
    return null;
  }
  const latestByNode = new Map<string, WorkflowStepRecord>();
  for (const step of steps) {
    const prev = latestByNode.get(step.nodeId);
    if (!prev || step.attempt >= prev.attempt) {
      latestByNode.set(step.nodeId, step);
    }
  }
  let blamed: WorkflowStepRecord | null = null;
  for (const step of latestByNode.values()) {
    if (step.status !== 'FAILED') {
      continue;
    }
    if (!blamed || stepTime(step) >= stepTime(blamed)) {
      blamed = step;
    }
  }
  return blamed;
}

function stepTime(step: WorkflowStepRecord): number {
  const t = step.endedAt ?? step.startedAt;
  return t ? Date.parse(t) : 0;
}
