import type { RepoWorkRequest, WorkflowResult } from '@auto-swe/shared/types/workflow';
import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';

// ── Activity Proxies ──

const stateActivities = proxyActivities<Pick<typeof activitiesType, 'updateDomainState'>>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '1s',
    maximumAttempts: 5,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '30s',
});

const agentActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    | 'executeImplementation'
    | 'executeCIFixImplementation'
    | 'executeReviewFixImplementation'
    | 'runReviewNetwork'
  >
>({
  heartbeatTimeout: '5m',
  retry: {
    backoffCoefficient: 2,
    initialInterval: '30s',
    maximumAttempts: 2,
    maximumInterval: '2m',
  },
  startToCloseTimeout: '30m',
});

const githubActivities = proxyActivities<
  Pick<typeof activitiesType, 'createOrUpdatePullRequest' | 'fetchCILogs'>
>({
  retry: {
    backoffCoefficient: 3,
    initialInterval: '5s',
    maximumAttempts: 4,
    maximumInterval: '2m',
  },
  startToCloseTimeout: '2m',
});

const contextActivities = proxyActivities<Pick<typeof activitiesType, 'validateContext'>>({
  heartbeatTimeout: '2m',
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 3,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '5m',
});

const memoryActivities = proxyActivities<Pick<typeof activitiesType, 'commitToMemory'>>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 3,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '5m',
});

// ── Signals ──

export const humanMergeSignal = defineSignal<[boolean]>('humanMergeSignal');
export const ciPipelineSignal =
  defineSignal<[{ passed: boolean; logsUrl?: string }]>('ciPipelineSignal');

// ── Constants ──

const MAX_CI_RETRIES = 3;
const MAX_REVIEW_RETRIES = 3;
const CI_SIGNAL_TIMEOUT = '4h';
const HUMAN_MERGE_TIMEOUT = '7d';

// ── Workflow ──

export async function EngineeringWorkflow(request: RepoWorkRequest): Promise<WorkflowResult> {
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
          lessonsGenerated: [],
          status: 'FAILED',
          totalCIRetries,
          totalReviewRetries,
        };
      }
      // Feed rejection back to implementer via a review-specific prompt
      codeResult = await agentActivities.executeReviewFixImplementation(
        reviewResult.rejectionSummary ?? '',
        codeResult
      );
      continue;
    }

    // 4. Open/Update PR
    await stateActivities.updateDomainState(workflowInfo().workflowId, 'AWAITING_CI');

    const prData = await githubActivities.createOrUpdatePullRequest(request, codeResult);

    // 5. Wait for CI pipeline signal
    const ciSignalReceived = await condition(() => ciResult !== null, CI_SIGNAL_TIMEOUT);

    if (!ciSignalReceived) {
      await stateActivities.updateDomainState(workflowInfo().workflowId, 'TIMED_OUT');
      return {
        lessonsGenerated: [],
        prNumber: prData.prNumber,
        prUrl: prData.prUrl,
        status: 'TIMED_OUT',
        totalCIRetries,
        totalReviewRetries,
      };
    }

    // setHandler() at the top of the workflow reassigns ciResult from a closure
    // that TS cannot see, so control-flow analysis narrows ciResult to its
    // initializer `null`. Cast back to the declared union to restore the truthy
    // branch.
    const ci = ciResult as { passed: boolean; logsUrl?: string } | null;
    if (!ci) {
      throw new Error('CI signal received but ciResult is null — invariant violated');
    }
    if (ci.passed) {
      isReadyForMerge = true;
    } else {
      totalCIRetries++;
      if (totalCIRetries >= MAX_CI_RETRIES) {
        await stateActivities.updateDomainState(workflowInfo().workflowId, 'FAILED');
        return {
          lessonsGenerated: [],
          prNumber: prData.prNumber,
          prUrl: prData.prUrl,
          status: 'FAILED',
          totalCIRetries,
          totalReviewRetries,
        };
      }

      // 6. CI Fix Loop
      const failedLogs = await githubActivities.fetchCILogs(ci.logsUrl);
      codeResult = await agentActivities.executeCIFixImplementation(failedLogs, codeResult);
    }
  }

  // 7. Wait for human merge
  await stateActivities.updateDomainState(workflowInfo().workflowId, 'AWAITING_HUMAN_MERGE');

  const merged = await condition(() => humanMerged, HUMAN_MERGE_TIMEOUT);

  if (!merged) {
    await stateActivities.updateDomainState(workflowInfo().workflowId, 'TIMED_OUT');
    return {
      lessonsGenerated: [],
      status: 'TIMED_OUT',
      totalCIRetries,
      totalReviewRetries,
    };
  }

  // 8. Memory Commit
  const lessonsGenerated: string[] = [];
  try {
    const lessonId = await memoryActivities.commitToMemory(
      workflowInfo().workflowId,
      request.repoId
    );
    if (lessonId) lessonsGenerated.push(lessonId);
  } catch {
    // Memory commit failure should not fail the workflow
  }

  // 9. Complete
  await stateActivities.updateDomainState(workflowInfo().workflowId, 'COMPLETED');

  return {
    lessonsGenerated,
    status: 'SUCCESS',
    totalCIRetries,
    totalReviewRetries,
  };
}
