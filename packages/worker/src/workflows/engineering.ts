import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import type { RepoWorkRequest, WorkflowResult } from '@auto-swe/shared/types/workflow';

// ── Activity Proxies ──

const stateActivities = proxyActivities<
  Pick<typeof activitiesType, 'updateDomainState'>
>({
  startToCloseTimeout: '30s',
  retry: {
    maximumAttempts: 5,
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
  },
});

const agentActivities = proxyActivities<
  Pick<typeof activitiesType, 'executeImplementation'>
>({
  startToCloseTimeout: '30m',
  heartbeatTimeout: '5m',
  retry: {
    maximumAttempts: 2,
    initialInterval: '30s',
    backoffCoefficient: 2,
    maximumInterval: '2m',
  },
});

const githubActivities = proxyActivities<
  Pick<typeof activitiesType, 'createOrUpdatePullRequest'>
>({
  startToCloseTimeout: '2m',
  retry: {
    maximumAttempts: 4,
    initialInterval: '5s',
    backoffCoefficient: 3,
    maximumInterval: '2m',
  },
});

// ── Signals ──

export const humanMergeSignal = defineSignal<[boolean]>('humanMergeSignal');

// ── Constants ──

const HUMAN_MERGE_TIMEOUT = '7d';

// ── Workflow ──

export async function EngineeringWorkflow(
  request: RepoWorkRequest,
): Promise<WorkflowResult> {
  let humanMerged = false;

  setHandler(humanMergeSignal, () => {
    humanMerged = true;
  });

  // 1. Implement
  await stateActivities.updateDomainState(request.workRequestId, 'IMPLEMENTING');

  const codeResult = await agentActivities.executeImplementation(request);

  // 2. Open PR
  const prData = await githubActivities.createOrUpdatePullRequest(
    request,
    codeResult,
  );

  // 3. Wait for human merge
  await stateActivities.updateDomainState(
    request.workRequestId,
    'AWAITING_HUMAN_MERGE',
  );

  const merged = await condition(() => humanMerged, HUMAN_MERGE_TIMEOUT);

  if (!merged) {
    await stateActivities.updateDomainState(request.workRequestId, 'TIMED_OUT');
    return {
      status: 'TIMED_OUT',
      prNumber: prData.prNumber,
      prUrl: prData.prUrl,
    };
  }

  // 4. Complete
  await stateActivities.updateDomainState(request.workRequestId, 'COMPLETED');

  return {
    status: 'SUCCESS',
    prNumber: prData.prNumber,
    prUrl: prData.prUrl,
  };
}
