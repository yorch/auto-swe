'use client';

import type { WorkflowRunDetail } from '@auto-swe/shared/types/api';
import { useCallback, useState } from 'react';
import { useRerunAgentRun } from '@/hooks/useAgentRuns';
import { useRetryWorkRequest } from '@/hooks/useRuns';
import { agentRunDeliver, describeLaunchError, rerunConsequence } from '@/lib/agentRun';

/**
 * The run page's Re-run. An agent run is re-run through its own endpoint (the
 * generic retry answers `409 USE_AGENT_RUN_RERUN`), and one that delivered (or
 * whose delivery is unknown) asks first, naming what it will create. A re-run
 * that publishes nothing, and every ordinary run, is one click.
 */
export function useRunReRun(
  run:
    | Pick<WorkflowRunDetail, 'contextSnapshot' | 'isAgentRun' | 'result' | 'workRequest'>
    | null
    | undefined
) {
  const generic = useRetryWorkRequest();
  const agent = useRerunAgentRun();
  const [confirming, setConfirming] = useState(false);

  const isAgentRun = run?.isAgentRun === true;
  const mutation = isAgentRun ? agent : generic;
  const consequence = isAgentRun && run ? rerunConsequence(agentRunDeliver(run)) : null;
  // One re-run per page view: a second click while one is in flight (or after it
  // started a run) would launch a duplicate.
  const locked = mutation.isPending || mutation.isSuccess;
  const workRequestId = run?.workRequest?.id;

  const request = useCallback(() => {
    if (!workRequestId || locked) {
      return;
    }
    if (consequence) {
      setConfirming(true);
      return;
    }
    mutation.mutate(workRequestId);
  }, [workRequestId, locked, consequence, mutation]);

  const confirm = useCallback(() => {
    setConfirming(false);
    if (workRequestId && !locked) {
      agent.mutate(workRequestId);
    }
  }, [workRequestId, locked, agent]);

  return {
    cancel: () => setConfirming(false),
    confirm,
    confirming,
    confirmMessage: consequence,
    data: mutation.data,
    error: mutation.error,
    errorView: mutation.isError ? describeLaunchError(mutation.error) : null,
    isAgentRun,
    isError: mutation.isError,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    locked,
    request,
  };
}
