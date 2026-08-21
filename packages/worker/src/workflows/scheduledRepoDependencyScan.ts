import { proxyActivities } from '@temporalio/workflow';
import type { detectRepoDependencies as detectRepoDependenciesType } from '../activities/detectRepoDependencies.js';
import type { getReposForDependencyScan as getReposForDependencyScanType } from '../activities/getReposForDependencyScan.js';
import { RETRY_SCHEDULED, T_2_MINUTES } from './proxyOptions.js';

const { getReposForDependencyScan: getRepos } = proxyActivities<{
  getReposForDependencyScan: typeof getReposForDependencyScanType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_2_MINUTES,
});

const { detectRepoDependencies: detectDependencies } = proxyActivities<{
  detectRepoDependencies: typeof detectRepoDependenciesType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_2_MINUTES,
});

export interface ScheduledRepoDependencyScanRepoResult {
  repoId: string;
  result: { edgesUpserted: number; scanned: string[]; suggestions: number } | { error: string };
}

export interface ScheduledRepoDependencyScanResult {
  repoResults: ScheduledRepoDependencyScanRepoResult[];
  reposScanned: number;
}

/**
 * Fan-out repo-dependency-detection workflow triggered by the Temporal
 * Schedule. Fetches every active git_repo connection and runs
 * `detectRepoDependencies` for each as an independent activity call, so a
 * failure scanning one repo (a rate limit, an auth error, a deleted repo)
 * does not abort the sweep for the others. Mirrors
 * `ScheduledRevalidationWorkflow`.
 */
export async function ScheduledRepoDependencyScanWorkflow(): Promise<ScheduledRepoDependencyScanResult> {
  const repos = await getRepos();

  const repoResults = await Promise.all(
    repos.map(async (r): Promise<ScheduledRepoDependencyScanRepoResult> => {
      try {
        const result = await detectDependencies({ repoId: r.repoId });
        return { repoId: r.repoId, result };
      } catch (err) {
        return {
          repoId: r.repoId,
          result: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    })
  );

  return { repoResults, reposScanned: repos.length };
}
