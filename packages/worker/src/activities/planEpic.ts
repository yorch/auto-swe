import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { EpicPlanRequest, EpicRepoEntry, RepoInfo } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { decomposeEpic } from '../agents/plannerAgent.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';

/**
 * Activity that uses the Planner Agent to decompose an epic into per-repo work items.
 * Fetches repo metadata from Prisma, calls the LLM planner, and returns EpicRepoEntry[].
 */
export async function planEpic(epicRequest: EpicPlanRequest): Promise<EpicRepoEntry[]> {
  heartbeat('fetching repo metadata');

  // Fetch repo metadata for the planner agent
  const repos = await runUnscoped(
    'ids come from the already-authorized epic request; scoped by id, not by tenant',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: { description: true, id: true, language: true, repoName: true },
        // Defensive: the epic submit route already filters to git_repo, but keep
        // the planner input git-only so a non-git id can never reach decomposition.
        where: { id: { in: epicRequest.repoIds }, type: 'git_repo' },
      })
  );

  const repoInfos: RepoInfo[] = repos.map(
    (r: {
      id: string;
      repoName: string | null;
      language: string | null;
      description: string | null;
    }) => ({
      description: r.description ?? '',
      language: r.language ?? 'unknown',
      name: r.repoName ?? '',
      repoId: r.id,
    })
  );

  heartbeat('decomposing epic via planner agent');

  const tracer = new AgentTracer();
  const activityCtx = await currentRequestContext();
  const skills = await loadAgentSkills('planner', activityCtx);
  const skillSuffix = skills
    .map((s) => s.promptText)
    .filter(Boolean)
    .join('\n\n');

  try {
    const plannedRepos = await decomposeEpic(
      epicRequest.description,
      repoInfos,
      tracer,
      skillSuffix || undefined
    );

    return plannedRepos.map((pr) => ({
      dependsOn: pr.dependsOn,
      repoId: pr.repoId,
    }));
  } finally {
    await persistActivityTrace(tracer, 'planner');
  }
}
