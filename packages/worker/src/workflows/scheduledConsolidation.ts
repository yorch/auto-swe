import type {
  ScheduledConsolidationInput,
  ScheduledConsolidationResult,
} from '@auto-swe/shared/types/workflow';
import { proxyActivities, startChild, workflowInfo } from '@temporalio/workflow';
import type { getReposForConsolidation } from '../activities/getReposForConsolidation.js';
import type { ConsolidateLessonsWorkflow as ConsolidateLessonsWorkflowType } from './consolidateLessons.js';

const { getReposForConsolidation: getRepos } = proxyActivities<{
  getReposForConsolidation: typeof getReposForConsolidation;
}>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 3,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '2 minutes',
});

/**
 * Fan-out consolidation workflow triggered by the Temporal Schedule.
 * Fetches all opted-in repos and runs ConsolidateLessonsWorkflow for each
 * as an independent child workflow, so failures are isolated per repo.
 */
export async function ScheduledConsolidationWorkflow(
  input: ScheduledConsolidationInput
): Promise<ScheduledConsolidationResult> {
  const repos = await getRepos();

  // Start all child workflows concurrently. Each child has its own timeout
  // and retry policy; a failure in one repo does not abort the others.
  const handles = await Promise.all(
    repos.map((r) =>
      startChild<typeof ConsolidateLessonsWorkflowType>('ConsolidateLessonsWorkflow', {
        args: [
          {
            minClusterSize: input.minClusterSize,
            repoId: r.repoId,
            similarityThreshold: input.similarityThreshold,
          },
        ],
        taskQueue: workflowInfo().taskQueue,
        workflowExecutionTimeout: '30 minutes',
        workflowId: `consolidate-lessons-${r.repoId}-${workflowInfo().workflowId}`,
      })
    )
  );

  // Collect results. await each handle individually so one failure doesn't
  // prevent results from other repos from being recorded.
  const repoResults = await Promise.all(
    handles.map(async (handle, i) => {
      try {
        const result = await handle.result();
        return { repoId: repos[i].repoId, result };
      } catch (err) {
        return {
          repoId: repos[i].repoId,
          result: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    })
  );

  return { repoResults, reposProcessed: repos.length };
}
