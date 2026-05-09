import type {
  EpicRepoEntry,
  EpicRequest,
  EpicResult,
  RepoWorkRequest,
  WorkflowResult,
} from '@auto-swe/shared/types/workflow';
import {
  defineSignal,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  startChild,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';

// Re-export types for external consumers
export type { EpicRepoEntry, EpicRequest, EpicResult };

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

const plannerActivities = proxyActivities<Pick<typeof activitiesType, 'planEpic'>>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 3,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '5m',
});

// ── Signals ──

export const epicCancelSignal = defineSignal('epicCancelSignal');

// ── Constants ──

const EPIC_TIMEOUT = '30d';

// ── Workflow ──

export async function EpicOrchestratorWorkflow(request: EpicRequest): Promise<EpicResult> {
  let cancelled = false;
  setHandler(epicCancelSignal, () => {
    cancelled = true;
  });

  // If no repos are pre-decomposed, use the Planner Agent to decompose the epic
  if (request.repos.length === 0 && request.repoIds && request.repoIds.length > 0) {
    const plannedRepos = await plannerActivities.planEpic({
      description: request.description,
      repoIds: request.repoIds,
      requestPayload: request.requestPayload,
      workRequestId: request.workRequestId,
    });
    request = { ...request, repos: plannedRepos };
  }

  const childResults: Record<string, WorkflowResult> = {};
  const completedRepos = new Set<string>();

  // Build dependency graph: for each repo, track which repos it depends on
  const repoMap = new Map(request.repos.map((r) => [r.repoId, r]));

  // Process repos respecting dependency order
  while (completedRepos.size < request.repos.length && !cancelled) {
    // Find repos whose dependencies are all satisfied
    const ready = request.repos.filter(
      (r) => !completedRepos.has(r.repoId) && r.dependsOn.every((dep) => completedRepos.has(dep))
    );

    if (ready.length === 0) {
      // All remaining repos have unsatisfied dependencies (likely a failed dep)
      break;
    }

    // Start ready repos in parallel as child workflows
    const childPromises = ready.map(async (repo) => {
      const childRequest: RepoWorkRequest = {
        description: request.description,
        externalTicketId: request.externalTicketId,
        parentWorkflowId: request.epicWorkflowId,
        repoId: repo.repoId,
        requestPayload: request.requestPayload,
        workRequestId: request.workRequestId,
      };

      // Scope the child ID to this epic execution so that retrying the epic
      // (which gets a new epicWorkflowId) doesn't collide with a previous run,
      // and so sibling repos within the same epic are always distinguishable.
      const childWorkflowId = `${request.epicWorkflowId}-${repo.repoId}`;

      try {
        const handle = await startChild('EngineeringWorkflow', {
          args: [childRequest],
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
          taskQueue: 'engineering-workflow',
          workflowId: childWorkflowId,
        });

        childResults[repo.repoId] = (await handle.result()) as WorkflowResult;
        if (childResults[repo.repoId].status === 'SUCCESS') {
          completedRepos.add(repo.repoId);
        }
      } catch (_err: unknown) {
        childResults[repo.repoId] = {
          lessonsGenerated: [],
          status: 'FAILED',
          totalCIRetries: 0,
          totalReviewRetries: 0,
        };
      }
    });

    await Promise.allSettled(childPromises);
  }

  // Determine overall status
  const allSuccess = request.repos.every((r) => childResults[r.repoId]?.status === 'SUCCESS');

  if (cancelled) {
    return { childResults, status: 'FAILED' };
  }

  return {
    childResults,
    status: allSuccess ? 'SUCCESS' : 'FAILED',
  };
}
