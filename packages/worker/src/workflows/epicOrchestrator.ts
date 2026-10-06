import type {
  EpicRepoEntry,
  EpicRequest,
  EpicResult,
  RepoWorkRequest,
  WorkflowResult,
} from '@auto-swe/shared/types/workflow';
import {
  CancellationScope,
  defineSignal,
  isCancellation,
  ParentClosePolicy,
  patched,
  proxyActivities,
  setHandler,
  startChild,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import { RETRY_STANDARD, RETRY_STATE, T_5M, T_30S } from './proxyOptions.js';

// Re-export types for external consumers
export type { EpicRepoEntry, EpicRequest, EpicResult };

// ── Activity Proxies ──

const stateActivities = proxyActivities<Pick<typeof activitiesType, 'updateDomainState'>>({
  retry: RETRY_STATE,
  startToCloseTimeout: T_30S,
});

const plannerActivities = proxyActivities<Pick<typeof activitiesType, 'planEpic'>>({
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_5M,
});

const templateActivities = proxyActivities<Pick<typeof activitiesType, 'resolveTemplateForRepo'>>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '1s',
    maximumAttempts: 3,
    maximumInterval: '10s',
  },
  startToCloseTimeout: T_30S,
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
  // Every child is started inside this scope, so cancelling it cancels the
  // children that are in flight (Temporal requests their cancellation and
  // waits for it), not just the loop that would have started more. The flag
  // alone used to be the whole cancel: running children kept going to a PR.
  const childScope = new CancellationScope();
  setHandler(epicCancelSignal, () => {
    cancelled = true;
    // Patched: a history recorded before children were cancelled contains no
    // cancel commands, and its replay must not issue them.
    if (patched('epic-cancel-children')) {
      childScope.cancel();
    }
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

  /** Run one repo's child workflow to a terminal verdict. Never rejects. */
  const runRepo = async (repo: EpicRepoEntry): Promise<void> => {
    const childRequest: RepoWorkRequest = {
      description: request.description,
      externalTicketId: request.externalTicketId,
      // The epic's launcher launched every child. Spread only when present,
      // so a child of an epic started before this field existed gets exactly
      // the input it always did.
      ...(request.launchedById ? { launchedById: request.launchedById } : {}),
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
    } catch (err: unknown) {
      childResults[repo.repoId] = {
        lessonsGenerated: [],
        status: 'FAILED',
        ...(cancelled || isCancellation(err) ? { skippedReason: 'epic cancelled' } : {}),
        totalCIRetries: 0,
        totalReviewRetries: 0,
      };
    }
    // Mark finished regardless of outcome — prevents infinite re-pickup of
    // repos that returned FAILED/TIMED_OUT/SKIPPED or threw.
    finishedRepos.add(repo.repoId);
  };

  /**
   * A repo that finished without SUCCESS blocks its transitive dependents:
   * mark them SKIPPED so the scheduler can terminate once every repo is
   * accounted for.
   */
  const skipDependentsOf = (repoId: string): void => {
    const result = childResults[repoId];
    if (!result || result.status === 'SUCCESS') {
      return;
    }
    for (const dependentId of computeTransitiveDependents(repoId, request.repos)) {
      if (!finishedRepos.has(dependentId)) {
        childResults[dependentId] = {
          lessonsGenerated: [],
          skippedReason: `upstream ${repoId} ${result.status.toLowerCase()}`,
          status: 'SKIPPED',
          totalCIRetries: 0,
          totalReviewRetries: 0,
        };
        finishedRepos.add(dependentId);
      }
    }
  };

  /**
   * Anything still unfinished has at least one dep that will never succeed
   * (chain of failures, a cycle, or an orphan dep id). Mark it SKIPPED so the
   * EpicResult is honest about what didn't run.
   */
  const skipUnreachable = (): void => {
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
  };

  // Event-driven: each repo starts the moment its own deps have succeeded,
  // rather than waiting for every sibling in its wave. Patched: a history
  // recorded under wave scheduling starts children in a different order, and
  // its replay must keep taking the wave path.
  const eventDriven = patched('epic-event-driven-scheduling');

  await childScope.run(async () => {
    if (eventDriven) {
      const started = new Set<string>();
      const inFlight = new Map<string, Promise<string>>();
      const startReady = (): void => {
        for (const r of request.repos) {
          if (cancelled) {
            return;
          }
          if (
            !started.has(r.repoId) &&
            !finishedRepos.has(r.repoId) &&
            r.dependsOn.every((dep) => succeededRepos.has(dep))
          ) {
            started.add(r.repoId);
            inFlight.set(
              r.repoId,
              runRepo(r).then(() => r.repoId)
            );
          }
        }
      };

      startReady();
      while (inFlight.size > 0) {
        const doneId = await Promise.race(inFlight.values());
        inFlight.delete(doneId);
        skipDependentsOf(doneId);
        startReady();
      }
      if (!cancelled) {
        skipUnreachable();
      }
      return;
    }

    // Wave scheduling, kept for histories recorded before the patch.
    while (finishedRepos.size < request.repos.length && !cancelled) {
      // A repo is ready when (a) it hasn't reached a terminal state yet AND
      // (b) every dep has SUCCEEDED. SKIPPED/FAILED deps never satisfy — their
      // transitive dependents get marked SKIPPED below.
      const ready = request.repos.filter(
        (r) => !finishedRepos.has(r.repoId) && r.dependsOn.every((dep) => succeededRepos.has(dep))
      );

      if (ready.length === 0) {
        skipUnreachable();
        break;
      }

      // Start ready repos in parallel as child workflows
      await Promise.allSettled(ready.map(runRepo));

      for (const repo of ready) {
        skipDependentsOf(repo.repoId);
      }
    }
  });

  // Determine overall status and emit terminal state
  if (cancelled) {
    await stateActivities.updateDomainState(request.epicWorkflowId, 'CANCELLED');
    return { childResults, status: 'CANCELLED' };
  }

  // An empty plan did no work, so it cannot have succeeded: `every` over no
  // repos is vacuously true. `planEpic` refuses to return one; this is the
  // orchestrator's own guard for a request that arrives with none.
  const allSuccess =
    request.repos.length > 0 &&
    request.repos.every((r) => childResults[r.repoId]?.status === 'SUCCESS');
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
