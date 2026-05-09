import { prisma } from '@auto-swe/shared/db';
import type { EpicPlanRequest, EpicRepoEntry, RepoInfo } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { decomposeEpic } from '../agents/plannerAgent.js';

/**
 * Activity that uses the Planner Agent to decompose an epic into per-repo work items.
 * Fetches repo metadata from Prisma, calls the LLM planner, and returns EpicRepoEntry[].
 */
export async function planEpic(epicRequest: EpicPlanRequest): Promise<EpicRepoEntry[]> {
  heartbeat('fetching repo metadata');

  // Fetch repo metadata for the planner agent
  const repos = await prisma.repository.findMany({
    where: { id: { in: epicRequest.repoIds } },
    select: { id: true, repoName: true, language: true, description: true },
  });

  const repoInfos: RepoInfo[] = repos.map(
    (r: { id: string; repoName: string; language: string | null; description: string | null }) => ({
      repoId: r.id,
      name: r.repoName,
      language: r.language ?? 'unknown',
      description: r.description ?? '',
    })
  );

  heartbeat('decomposing epic via planner agent');

  const plannedRepos = await decomposeEpic(epicRequest.description, repoInfos);

  return plannedRepos.map((pr) => ({
    repoId: pr.repoId,
    dependsOn: pr.dependsOn,
  }));
}
