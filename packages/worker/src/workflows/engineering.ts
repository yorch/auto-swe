import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
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
  Pick<typeof activitiesType, 'executeImplementation' | 'executeCIFixImplementation' | 'executeReviewFixImplementation' | 'runReviewNetwork'>
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
  Pick<typeof activitiesType, 'createOrUpdatePullRequest' | 'fetchCILogs'>
>({
  startToCloseTimeout: '2m',
  retry: {
    maximumAttempts: 4,
    initialInterval: '5s',
    backoffCoefficient: 3,
    maximumInterval: '2m',
  },
});

const contextActivities = proxyActivities<
  Pick<typeof activitiesType, 'validateContext'>
>({
  startToCloseTimeout: '5m',
  heartbeatTimeout: '2m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5s',
    backoffCoefficient: 2,
    maximumInterval: '1m',
  },
});

const memoryActivities = proxyActivities<
  Pick<typeof activitiesType, 'commitToMemory'>
>({
  startToCloseTimeout: '5m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5s',
    backoffCoefficient: 2,
    maximumInterval: '1m',
  },
});

// ── Signals ──

export const humanMergeSignal = defineSignal<[boolean]>('humanMergeSignal');
export const ciPipelineSignal = defineSignal<[{ passed: boolean; logsUrl?: string }]>('ciPipelineSignal');

// ── Constants ──

const MAX_CI_RETRIES = 3;
const MAX_REVIEW_RETRIES = 3;
const CI_SIGNAL_TIMEOUT = '4h';
const HUMAN_MERGE_TIMEOUT = '7d';

// ── Workflow ──

export async function EngineeringWorkflow(
  request: RepoWorkRequest,
): Promise<WorkflowResult> {
  let ciResult: { passed: boolean; logsUrl?: string } | null = null;
  let humanMerged = false;
  let totalCIRetries = 0;
  let totalReviewRetries = 0;

  setHandler(ciPipelineSignal, (payload) => {
    ciResult = payload;
  });
  setHandler(humanMergeSignal, (merged) => {
    humanMerged = merged;
  });

  // 1. Context Validation Phase
  await stateActivities.updateDomainState(workflowInfo().workflowId, 'VALIDATING_CONTEXT');

  let successCriteria: string[] = [];
  try {
    const contextResult = await contextActivities.validateContext(request);
    successCriteria = contextResult.successCriteria;
  } catch {
    // Context validation failure should not block the workflow
  }

  // 2. Implementation Phase
  await stateActivities.updateDomainState(workflowInfo().workflowId, 'IMPLEMENTING');

  let codeResult = await agentActivities.executeImplementation(request);

  let isReadyForMerge = false;

  while (!isReadyForMerge) {
    // Reset ciResult at the top of each iteration. A CI signal from a previous
    // push can arrive while the review agent is running; if the review then
    // rejects and we loop back, we must not satisfy the next CI wait with that
    // stale result.
    ciResult = null;

    // 3. Review Network
    await stateActivities.updateDomainState(workflowInfo().workflowId, 'IN_REVIEW');

    const reviewResult = await agentActivities.runReviewNetwork(codeResult, successCriteria);

    if (!reviewResult.approved) {
      totalReviewRetries++;
      if (totalReviewRetries >= MAX_REVIEW_RETRIES) {
        await stateActivities.updateDomainState(workflowInfo().workflowId, 'FAILED');
        return {
          status: 'FAILED',
          totalCIRetries,
          totalReviewRetries,
          lessonsGenerated: [],
        };
      }
      // Feed rejection back to implementer via a review-specific prompt
      codeResult = await agentActivities.executeReviewFixImplementation(
        reviewResult.rejectionSummary!,
        codeResult,
      );
      continue;
    }

    // 4. Open/Update PR
    await stateActivities.updateDomainState(workflowInfo().workflowId, 'AWAITING_CI');

    const prData = await githubActivities.createOrUpdatePullRequest(
      request,
      codeResult,
    );

    // 5. Wait for CI pipeline signal
    const ciSignalReceived = await condition(() => ciResult !== null, CI_SIGNAL_TIMEOUT);

    if (!ciSignalReceived) {
      await stateActivities.updateDomainState(workflowInfo().workflowId, 'TIMED_OUT');
      return {
        status: 'TIMED_OUT',
        prNumber: prData.prNumber,
        prUrl: prData.prUrl,
        totalCIRetries,
        totalReviewRetries,
        lessonsGenerated: [],
      };
    }

    if (ciResult!.passed) {
      isReadyForMerge = true;
    } else {
      totalCIRetries++;
      if (totalCIRetries >= MAX_CI_RETRIES) {
        await stateActivities.updateDomainState(workflowInfo().workflowId, 'FAILED');
        return {
          status: 'FAILED',
          prNumber: prData.prNumber,
          prUrl: prData.prUrl,
          totalCIRetries,
          totalReviewRetries,
          lessonsGenerated: [],
        };
      }

      // 6. CI Fix Loop
      const failedLogs = await githubActivities.fetchCILogs(ciResult!.logsUrl);
      codeResult = await agentActivities.executeCIFixImplementation(failedLogs, codeResult);
    }
  }

  // 7. Wait for human merge
  await stateActivities.updateDomainState(workflowInfo().workflowId, 'AWAITING_HUMAN_MERGE');

  const merged = await condition(() => humanMerged, HUMAN_MERGE_TIMEOUT);

  if (!merged) {
    await stateActivities.updateDomainState(workflowInfo().workflowId, 'TIMED_OUT');
    return {
      status: 'TIMED_OUT',
      totalCIRetries,
      totalReviewRetries,
      lessonsGenerated: [],
    };
  }

  // 8. Memory Commit
  const lessonsGenerated: string[] = [];
  try {
    const lessonId = await memoryActivities.commitToMemory(
      workflowInfo().workflowId,
      request.repoId,
    );
    if (lessonId) lessonsGenerated.push(lessonId);
  } catch {
    // Memory commit failure should not fail the workflow
  }

  // 9. Complete
  await stateActivities.updateDomainState(workflowInfo().workflowId, 'COMPLETED');

  return {
    status: 'SUCCESS',
    totalCIRetries,
    totalReviewRetries,
    lessonsGenerated,
  };
}
