import { prisma } from '@auto-swe/shared/db';
import { resolveRepoDependencyContext } from '@auto-swe/shared/lib/repoDependencyResolver';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { EpicPlanRequest, EpicRepoEntry, RepoInfo } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { decomposeEpic } from '../agents/plannerAgent.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';

/**
 * Does `from` already depend on `to`, directly or transitively, under `graph`?
 *
 * `graph` maps a repo to the repos it depends on. Iterative + visited-guarded so
 * a cycle already present in the planner's output cannot hang this walk.
 */
function dependsOnTransitively(graph: Map<string, Set<string>>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || seen.has(node)) {
      continue;
    }
    seen.add(node);
    if (node === to) {
      return true;
    }
    for (const next of graph.get(node) ?? []) {
      stack.push(next);
    }
  }
  return false;
}

/**
 * Union the planner's guessed `dependsOn` with the durable dependency graph.
 *
 * A recorded `active` edge is authoritative — it is a fact about the system,
 * where the planner's ordering is an inference from prose. But unioning two
 * orderings can close a loop, and `epicOrchestrator`'s ready-loop deadlocks on a
 * repo whose `dependsOn` can never be satisfied (it reports the epic FAILED with
 * unsatisfied dependencies). So each stored edge is admitted only if the repo it
 * would depend on does not already depend on it — the edge that would close a
 * cycle is dropped, and the planner's ordering wins for that pair.
 *
 * Pure and deterministic: entries keep their input order, added deps are sorted,
 * and self-edges plus repos outside the epic are never introduced.
 *
 * @param entries planner output, in planner order
 * @param storedUpstream repoId → repos it depends on, from the durable graph
 */
export function mergeStoredDependencies(
  entries: EpicRepoEntry[],
  storedUpstream: Map<string, string[]>
): EpicRepoEntry[] {
  const inEpic = new Set(entries.map((e) => e.repoId));
  // Working graph, seeded from the planner and grown as edges are admitted, so
  // the cycle check sees every edge accepted so far (not just the planner's).
  const graph = new Map<string, Set<string>>(entries.map((e) => [e.repoId, new Set(e.dependsOn)]));

  return entries.map((entry) => {
    const deps = graph.get(entry.repoId) ?? new Set<string>();
    const added: string[] = [];
    for (const dep of [...(storedUpstream.get(entry.repoId) ?? [])].sort()) {
      if (dep === entry.repoId || !inEpic.has(dep) || deps.has(dep)) {
        continue;
      }
      if (dependsOnTransitively(graph, dep, entry.repoId)) {
        continue; // would close a cycle → epicOrchestrator could never schedule it
      }
      deps.add(dep);
      added.push(dep);
    }
    // Planner output passes through untouched; the graph only ever appends.
    return { dependsOn: [...entry.dependsOn, ...added], repoId: entry.repoId };
  });
}

/**
 * Read each epic repo's stored upstream neighbours (`active` edges only, org-
 * scoped to the repo's own team) as `repoId → upstream repoIds`.
 *
 * Reuses the shared resolver rather than querying edges here, so the
 * "proposals and dismissed edges never reach an agent" rule has exactly one
 * implementation.
 */
async function loadStoredUpstream(
  repos: { id: string; team: { orgId: string } }[]
): Promise<Map<string, string[]>> {
  const pairs = await Promise.all(
    repos.map(async (r) => {
      const { upstream } = await resolveRepoDependencyContext(prisma, r.id, {
        orgId: r.team.orgId,
      });
      return [r.id, upstream.map((n) => n.repo.id)] as const;
    })
  );
  return new Map(pairs);
}

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
        select: {
          description: true,
          id: true,
          language: true,
          repoName: true,
          // The dependency graph is org-scoped; `planEpic` has no request context
          // to read an orgId from, so it comes off the repo's own team.
          team: { select: { orgId: true } },
        },
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

    const entries: EpicRepoEntry[] = plannedRepos.map((pr) => ({
      dependsOn: pr.dependsOn,
      repoId: pr.repoId,
    }));

    // Seed the epic DAG from the durable dependency graph: a recorded `active`
    // edge between two repos in this epic is a fact, and outranks the planner's
    // guess. Best-effort — if the graph is unreadable the planner's output
    // stands unchanged, and a stored edge that would close a cycle is dropped
    // rather than deadlocking `epicOrchestrator`'s ready-loop.
    try {
      const storedUpstream = await loadStoredUpstream(repos);
      const merged = mergeStoredDependencies(entries, storedUpstream);
      const addedCount = merged.reduce(
        (sum, m, i) => sum + (m.dependsOn.length - entries[i].dependsOn.length),
        0
      );
      tracer.addActivityEvent({
        name: 'epic.stored_dependencies_merged',
        outputJson: { addedEdges: addedCount, repos: merged.length },
      });
      return merged;
    } catch {
      return entries;
    }
  } finally {
    await persistActivityTrace(tracer, 'planner');
  }
}
