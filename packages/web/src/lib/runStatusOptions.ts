import { WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from '@auto-swe/shared/types/api';

const LABELS: Record<WorkflowRunStatus, string> = {
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
  RUNNING: 'Running',
  SKIPPED: 'Skipped',
  SUCCESS: 'Succeeded',
  TIMED_OUT: 'Timed out',
};

/**
 * Options for a run-status filter, built from the shared status list the
 * gateway validates `?status=` against — so a filter value can never name a
 * status no run has (the old hand-written list offered `SUCCEEDED`).
 */
export function runStatusOptions(): { label: string; value: '' | WorkflowRunStatus }[] {
  return [
    { label: 'All statuses', value: '' },
    ...WORKFLOW_RUN_STATUSES.map((s) => ({ label: LABELS[s], value: s })),
  ];
}

export function isRunStatus(value: string): value is WorkflowRunStatus {
  return (WORKFLOW_RUN_STATUSES as readonly string[]).includes(value);
}
