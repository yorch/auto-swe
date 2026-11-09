import type { WorkflowRunStatus } from '@auto-swe/shared/types/api';

interface Execution {
  id: string;
  status: WorkflowRunStatus;
  workflowId: string;
  workRequestId: string | null;
  _count: { humanSteps: number };
  workRequest: {
    isCrossRepo: boolean;
    activeWorkflows: { temporalWorkflowId: string; currentStatus: string }[];
  } | null;
}

/** Latest rows arrive in descending execution order, one per request/connection. */
export function groupRequestExecutions(runs: Execution[]) {
  const groups = new Map<string, Execution[]>();
  for (const run of runs) {
    const key = run.workRequestId ?? run.id;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const isCrossRepo = group[0].workRequest?.isCrossRepo === true;
    const executions = isCrossRepo ? group : [group[0]];
    const status =
      (['RUNNING', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'SUCCESS', 'SKIPPED'] as const).find(
        (candidate) => executions.some((run) => run.status === candidate)
      ) ?? 'SKIPPED';
    const representative = executions.find((run) => run.status === status) ?? executions[0];
    const failedRuns = executions.filter(
      (run) => run.status === 'FAILED' || run.status === 'TIMED_OUT'
    );
    const mergeRuns = executions.filter(
      (run) =>
        run.status === 'RUNNING' &&
        run.workRequest?.activeWorkflows.some(
          (ledger) =>
            ledger.temporalWorkflowId === run.workflowId &&
            ledger.currentStatus === 'AWAITING_HUMAN_MERGE'
        )
    );
    return {
      failedExecutionCount: failedRuns.length,
      /** Every failed or timed-out execution, for a caller that must name each one. */
      failedRunIds: failedRuns.map((run) => run.id),
      id: representative.id,
      isCrossRepo,
      /** Every execution whose pull request awaits a human merge. */
      mergeRunIds: mergeRuns.map((run) => run.id),
      needsMerge: mergeRuns.length > 0,
      pendingStepCount: executions.reduce((total, run) => total + run._count.humanSteps, 0),
      runIds: executions.map((run) => run.id),
      status,
      visibleExecutionCount: executions.length,
    };
  });
}
