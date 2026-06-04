import { prisma } from '@auto-swe/shared/db';
import type { EpicPlanRequest, EpicRepoEntry, RepoInfo } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { decomposeEpic } from '../agents/plannerAgent.js';
import { currentActivityType, currentWorkflowRunId } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';

/**
 * Activity that uses the Planner Agent to decompose an epic into per-repo work items.
 * Fetches repo metadata from Prisma, calls the LLM planner, and returns EpicRepoEntry[].
 */
export async function planEpic(epicRequest: EpicPlanRequest): Promise<EpicRepoEntry[]> {
  heartbeat('fetching repo metadata');

  // Fetch repo metadata for the planner agent
  const repos = await prisma.repository.findMany({
    select: { description: true, id: true, language: true, repoName: true },
    where: { id: { in: epicRequest.repoIds } },
  });

  const repoInfos: RepoInfo[] = repos.map(
    (r: { id: string; repoName: string; language: string | null; description: string | null }) => ({
      description: r.description ?? '',
      language: r.language ?? 'unknown',
      name: r.repoName,
      repoId: r.id,
    })
  );

  heartbeat('decomposing epic via planner agent');

  const tracer = new AgentTracer();
  const plannedRepos = await decomposeEpic(epicRequest.description, repoInfos, tracer);
  await tracer.persist(await currentWorkflowRunId(), currentActivityType(), 'planner');

  return plannedRepos.map((pr) => ({
    dependsOn: pr.dependsOn,
    repoId: pr.repoId,
  }));
}
