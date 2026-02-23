import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  startChild,
  ParentClosePolicy,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import type { RepoWorkRequest, WorkflowResult } from '@auto-swe/shared/types/workflow';

// ── Types ──

export interface EpicRequest {
  epicWorkflowId: string;
  externalTicketId: string;
  description: string;
  requestPayload: string;
  workRequestId: string;
  repos: EpicRepoEntry[];
}

export interface EpicRepoEntry {
  repoId: string;
  dependsOn: string[]; // repoIds that must complete before this one starts
}

export interface EpicResult {
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT';
  childResults: Record<string, WorkflowResult>;
}

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

// ── Signals ──

export const epicCancelSignal = defineSignal('epicCancelSignal');

// ── Constants ──

const EPIC_TIMEOUT = '30d';

// ── Workflow ──

export async function EpicOrchestratorWorkflow(
  request: EpicRequest,
): Promise<EpicResult> {
  let cancelled = false;
  setHandler(epicCancelSignal, () => {
    cancelled = true;
  });

  const childResults: Record<string, WorkflowResult> = {};
  const completedRepos = new Set<string>();

  // Build dependency graph: for each repo, track which repos it depends on
  const repoMap = new Map(request.repos.map((r) => [r.repoId, r]));

  // Process repos respecting dependency order
  while (completedRepos.size < request.repos.length && !cancelled) {
    // Find repos whose dependencies are all satisfied
    const ready = request.repos.filter(
      (r) =>
        !completedRepos.has(r.repoId) &&
        r.dependsOn.every((dep) => completedRepos.has(dep)),
    );

    if (ready.length === 0) {
      // All remaining repos have unsatisfied dependencies (likely a failed dep)
      break;
    }

    // Start ready repos in parallel as child workflows
    const childPromises = ready.map(async (repo) => {
      const childRequest: RepoWorkRequest = {
        workRequestId: request.workRequestId,
        repoId: repo.repoId,
        externalTicketId: request.externalTicketId,
        description: request.description,
        requestPayload: request.requestPayload,
        parentWorkflowId: request.epicWorkflowId,
      };

      const childWorkflowId = `eng-${request.externalTicketId}-${repo.repoId}`;

      try {
        const result = await startChild('EngineeringWorkflow', {
          workflowId: childWorkflowId,
          taskQueue: 'engineering-workflow',
          args: [childRequest],
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
        });

        childResults[repo.repoId] = await result;
        if (childResults[repo.repoId].status === 'SUCCESS') {
          completedRepos.add(repo.repoId);
        }
      } catch (err: any) {
        childResults[repo.repoId] = {
          status: 'FAILED',
          totalCIRetries: 0,
          totalReviewRetries: 0,
          lessonsGenerated: [],
        };
      }
    });

    await Promise.allSettled(childPromises);
  }

  // Determine overall status
  const allSuccess = request.repos.every(
    (r) => childResults[r.repoId]?.status === 'SUCCESS',
  );

  if (cancelled) {
    return { status: 'FAILED', childResults };
  }

  return {
    status: allSuccess ? 'SUCCESS' : 'FAILED',
    childResults,
  };
}
