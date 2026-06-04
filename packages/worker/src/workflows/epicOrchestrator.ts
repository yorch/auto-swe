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

const templateActivities = proxyActivities<Pick<typeof activitiesType, 'resolveTemplateForRepo'>>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '1s',
    maximumAttempts: 3,
    maximumInterval: '10s',
  },
  startToCloseTimeout: '30s',
});

// ── Signals ──

export const epicCancelSignal = defineSignal('epicCancelSignal');

// ── Workflow ──

/**
 * Compute the transitive closure of dependents for a given repoId.
 * If B depends on A, and C depends on B, then dependents('A') === {B, C}.
 * Used to mark all downstream repos as SKIPPED when an upstream repo fails.
 *
 * The failed repo itself is never included in the result, even when reachable
 * via a cycle (A ↔ B). The caller already has a terminal verdict (FAILED) for
 * the failed repo and must not have it overwritten as SKIPPED.
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
  const visited = new Set<string>([failedRepoId]); // seed with start so cycles cannot re-add it
  const dependents = new Set<string>();
  const stack = [failedRepoId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) {
      continue;
    }
    for (const dependent of dependentsByDep.get(id) ?? []) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        dependents.add(dependent);
        stack.push(dependent);
      }
    }
  }
  return dependents;
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
  // succeededRepos gates dependency satisfaction — only SUCCESS unblocks dependents.
  const succeededRepos = new Set<string>();
  // finishedRepos covers any terminal verdict (SUCCESS, FAILED, TIMED_OUT, SKIPPED).
  // This is what the loop and `ready` filter use to avoid re-running the same child,
  // which would otherwise hit WorkflowExecutionAlreadyStartedError on every iteration.
  const finishedRepos = new Set<string>();

  // Process repos respecting dependency order
  while (finishedRepos.size < request.repos.length && !cancelled) {
    // A repo is ready when (a) it hasn't reached a terminal state yet AND
    // (b) every dep has SUCCEEDED. SKIPPED/FAILED deps never satisfy — their
    // transitive dependents get marked SKIPPED below.
    const ready = request.repos.filter(
      (r) => !finishedRepos.has(r.repoId) && r.dependsOn.every((dep) => succeededRepos.has(dep))
    );

    if (ready.length === 0) {
      // No repos are runnable. Anything left has at least one dep that finished
      // without succeeding (chain of failures, or orphan dep id). Mark remaining
      // repos SKIPPED so the EpicResult is honest about what didn't run.
      for (const r of request.repos) {
        if (!finishedRepos.has(r.repoId)) {
          const blockingDeps = r.dependsOn.filter((dep) => !succeededRepos.has(dep));
          childResults[r.repoId] = {
            lessonsGenerated: [],
            skippedReason: `upstream dependency unsatisfied: ${blockingDeps.join(', ')}`,
            status: 'SKIPPED',
            totalCIRetries: 0,
            totalReviewRetries: 0,
          };
          finishedRepos.add(r.repoId);
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
        // Each child resolves its own template from its repo's team default
        // (with global fallback). Different repos in one epic may belong to
        // different teams and want different workflows.
        const { templateId, templateVersion } = await templateActivities.resolveTemplateForRepo(
          repo.repoId
        );
        const handle = await startChild('RunnableWorkflow', {
          args: [{ request: childRequest, templateId, templateVersion }],
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
          taskQueue: 'engineering-workflow',
          workflowId: childWorkflowId,
        });

        const result = (await handle.result()) as WorkflowResult;
        childResults[repo.repoId] = result;
        if (result.status === 'SUCCESS') {
          succeededRepos.add(repo.repoId);
        }
      } catch (_err: unknown) {
        childResults[repo.repoId] = {
          lessonsGenerated: [],
          status: 'FAILED',
          totalCIRetries: 0,
          totalReviewRetries: 0,
        };
      }
      // Mark finished regardless of outcome — prevents infinite re-pickup of
      // repos that returned FAILED/TIMED_OUT/SKIPPED or threw.
      finishedRepos.add(repo.repoId);
    });

    await Promise.allSettled(childPromises);

    // Propagate failure: any repo that just finished without SUCCESS blocks its
    // transitive dependents. Mark them SKIPPED here so the next loop iteration
    // can terminate cleanly when all repos are accounted for.
    for (const repo of ready) {
      const result = childResults[repo.repoId];
      if (result && result.status !== 'SUCCESS') {
        for (const dependentId of computeTransitiveDependents(repo.repoId, request.repos)) {
          if (!finishedRepos.has(dependentId)) {
            childResults[dependentId] = {
              lessonsGenerated: [],
              skippedReason: `upstream ${repo.repoId} ${result.status.toLowerCase()}`,
              status: 'SKIPPED',
              totalCIRetries: 0,
              totalReviewRetries: 0,
            };
            finishedRepos.add(dependentId);
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
