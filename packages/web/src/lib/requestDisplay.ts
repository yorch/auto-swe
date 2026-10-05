import type { WorkspaceRequestSummary } from '@auto-swe/shared/types/api';
import { formatDuration } from '@/lib/utils';

export function requestProgress(
  request: Pick<WorkspaceRequestSummary, 'status' | 'pendingStepCount' | 'stage'> &
    Partial<Pick<WorkspaceRequestSummary, 'isCrossRepo' | 'failedExecutionCount'>>
): string {
  if (request.isCrossRepo && request.failedExecutionCount) {
    return `${request.failedExecutionCount} repository executions failed or timed out`;
  }
  if (request.pendingStepCount > 0) {
    return 'Waiting for a response';
  }
  if (request.status === 'RUNNING' && request.stage === 'AWAITING_HUMAN_MERGE') {
    return 'Pull request ready for review';
  }
  if (request.status === 'RUNNING' && request.stage === 'AWAITING_CI') {
    return 'Waiting for CI checks';
  }
  switch (request.status) {
    case 'RUNNING':
      return 'Work is in progress';
    case 'SUCCESS':
      return 'Finished — view the result';
    case 'FAILED':
      return 'The latest attempt failed';
    case 'TIMED_OUT':
      return 'The latest attempt timed out';
    case 'CANCELLED':
      return 'The latest attempt was cancelled';
    default:
      return 'The latest attempt was skipped';
  }
}

export function requestHref(requestId: string): string {
  return `/workflows?request=${encodeURIComponent(requestId)}`;
}

export interface AttentionReason {
  label: string;
  tone: 'amber' | 'brick' | 'violet';
}

/** Why a request is asking for attention, in the order a person would act on it. */
export function attentionReasons(
  request: Pick<WorkspaceRequestSummary, 'status' | 'pendingStepCount'> &
    Partial<Pick<WorkspaceRequestSummary, 'needsMerge' | 'pendingStepDeadline'>>,
  now = Date.now()
): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (request.pendingStepCount > 0) {
    let label = 'Awaiting approval';
    if (request.pendingStepDeadline) {
      const msLeft = new Date(request.pendingStepDeadline).getTime() - now;
      label += msLeft <= 0 ? ' · overdue' : ` · ${formatDuration(msLeft)} left`;
    }
    reasons.push({ label, tone: 'amber' });
  }
  if (request.status === 'FAILED' || request.status === 'TIMED_OUT') {
    reasons.push({ label: request.status === 'FAILED' ? 'Failed' : 'Timed out', tone: 'brick' });
  }
  if (request.needsMerge) {
    reasons.push({ label: 'Needs review', tone: 'violet' });
  }
  return reasons;
}
