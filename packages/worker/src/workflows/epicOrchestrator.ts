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

// ── Workflow ──

/**
 * Compute the transitive closure of dependents for a given repoId.
 * If A depends on B, and B depends on C, then dependentsOf(C) === {B, A}.
 * Used to mark all downstream repos as SKIPPED when an upstream repo fails.
 */
export function computeTransitiveDependents(
  failedRepoId: string,
  repos: EpicRepoEntry[]
): Set<string> {
  const dependentsByDep = new Map<string, string[]>();
  for (const r of repos) {
    for (const dep of r.dependsOn) {
      const list = dependentsByDep.get(dep) ?? [];
      list.push(r.repoId);
      dependentsByDep.set(dep, list);
    }
  }
  const skipped = new Set<string>();
  const stack = [failedRepoId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) continue;
    for (const dependent of dependentsByDep.get(id) ?? []) {
      if (!skipped.has(dependent)) {
        skipped.add(dependent);
        stack.push(dependent);
      }
    }
  }
  return skipped;
}

export async function EpicOrchestratorWorkflow(request: EpicRequest): Promise<EpicResult> {
  let cancelled = false;
  setHandler(epicCancelSignal, () => {
    cancelled = true;
  });

  // If no repos are pre-decomposed, use the Planner Agent to decompose the epic
  if (request.repos.length === 0 && request.repoIds && request.repoIds.length > 0) {
    await stateActivities.updateDomainState(request.epicWorkflowId, 'PLANNING');
    const plannedRepos = await plannerActivities.planEpic({
      description: request.description,
      repoIds: request.repoIds,
      requestPayload: request.requestPayload,
      workRequestId: request.workRequestId,
    });
    request = { ...request, repos: plannedRepos };
  }

  await stateActivities.updateDomainState(request.epicWorkflowId, 'FANNING_OUT');

  const childResults: Record<string, WorkflowResult> = {};
  const completedRepos = new Set<string>();
  // Repos that should not be started because an upstream dependency failed.
  // Tracked separately from completedRepos because their status is SKIPPED, not SUCCESS.
  const skippedRepos = new Set<string>();

  // Process repos respecting dependency order
  while (completedRepos.size + skippedRepos.size < request.repos.length && !cancelled) {
    // Find repos whose dependencies are all satisfied (succeeded). A SKIPPED
    // dependency does NOT satisfy — it triggers further skipping.
    const ready = request.repos.filter(
      (r) =>
        !completedRepos.has(r.repoId) &&
        !skippedRepos.has(r.repoId) &&
        r.dependsOn.every((dep) => completedRepos.has(dep))
    );

    if (ready.length === 0) {
      // No repos are runnable. Anything left has an unsatisfied dep (chain of failures).
      // Mark them all as SKIPPED so the EpicResult is honest about what didn't run.
      for (const r of request.repos) {
        if (!completedRepos.has(r.repoId) && !skippedRepos.has(r.repoId)) {
          const blockingDeps = r.dependsOn.filter((dep) => !completedRepos.has(dep));
          childResults[r.repoId] = {
            lessonsGenerated: [],
            skippedReason: `upstream dependency unsatisfied: ${blockingDeps.join(', ')}`,
            status: 'SKIPPED',
            totalCIRetries: 0,
            totalReviewRetries: 0,
          };
          skippedRepos.add(r.repoId);
        }
      }
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

    // Propagate failure: any repo that just failed (or returned non-SUCCESS) blocks
    // its transitive dependents — mark them SKIPPED so the next loop iteration
    // doesn't sit waiting for an impossible "ready" set.
    for (const repo of ready) {
      const result = childResults[repo.repoId];
      if (result && result.status !== 'SUCCESS') {
        for (const dependentId of computeTransitiveDependents(repo.repoId, request.repos)) {
          if (!completedRepos.has(dependentId) && !skippedRepos.has(dependentId)) {
            childResults[dependentId] = {
              lessonsGenerated: [],
              skippedReason: `upstream ${repo.repoId} ${result.status.toLowerCase()}`,
              status: 'SKIPPED',
              totalCIRetries: 0,
              totalReviewRetries: 0,
            };
            skippedRepos.add(dependentId);
          }
        }
      }
    }
  }

  // Determine overall status and emit terminal state
  if (cancelled) {
    await stateActivities.updateDomainState(request.epicWorkflowId, 'CANCELLED');
    return { childResults, status: 'CANCELLED' };
  }

  const allSuccess = request.repos.every((r) => childResults[r.repoId]?.status === 'SUCCESS');
  const finalStatus = allSuccess ? 'SUCCESS' : 'FAILED';
  await stateActivities.updateDomainState(
    request.epicWorkflowId,
    allSuccess ? 'COMPLETED' : 'FAILED'
  );

  return {
    childResults,
    status: finalStatus,
  };
}
