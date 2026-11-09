import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { summarizePullRequestOutcomes } from '@auto-swe/shared/lib/pullRequestOutcomes';
import type { PullRequestOutcomeSummary } from '@auto-swe/shared/types/api';
import { runMetricsTeamScope } from './runTeamScope.js';
import type { VisibilityActor } from './runVisibility.js';
import { type MaybeGate, reachableConnections } from './tenantScope.js';

/** Most rows one outcomes read takes; one more is fetched to detect a cut. */
export const OUTCOMES_ROW_CAP = 10_000;

/**
 * The pull requests an outcomes read or export covers: the ones the caller may reach, opened in
 * `[openedFrom, end)`, narrowed by the query. One definition, so the export can never reach a row
 * the summary would not.
 */
export function outcomesFilters(
  user: VisibilityActor,
  gate: MaybeGate,
  query: {
    repoId?: string | undefined;
    scope: 'MINE' | 'TEAM';
    teamId?: string | undefined;
    templateId?: string | undefined;
  },
  openedFrom: Date,
  end: Date
): Prisma.PullRequestWhereInput[] {
  const filters: Prisma.PullRequestWhereInput[] = [
    user.role === 'ADMIN' ? {} : { repository: reachableConnections(user, gate) },
    { openedAt: { gte: openedFrom, lt: end } },
  ];
  if (query.repoId) {
    filters.push({ repoId: query.repoId });
  }
  if (query.teamId) {
    const { teamId } = query;
    // A metric: owner-only attribution, so a shared repository is not counted by two teams.
    filters.push({ run: runMetricsTeamScope(teamId) });
  }
  if (query.scope === 'MINE') {
    filters.push({ workflow: { workRequest: { requestedById: user.sub } } });
  }
  if (query.templateId) {
    filters.push({ templateId: query.templateId });
  }
  return filters;
}

/**
 * Delivery figures for the pull requests one team owns (owner-attributed) that were opened in
 * `[from, to)`, as `GET /pull-requests/outcomes?scope=TEAM&teamId=` summarises them: the same
 * filters, the same row cap, the same summary function.
 */
export async function teamPullRequestOutcomes(
  prisma: PrismaClient,
  user: VisibilityActor,
  gate: MaybeGate,
  teamId: string,
  from: Date,
  to: Date
): Promise<PullRequestOutcomeSummary> {
  const rows = await prisma.pullRequest.findMany({
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    select: { ciStatus: true, isDraft: true, mergedAt: true, openedAt: true, status: true },
    take: OUTCOMES_ROW_CAP,
    where: { AND: outcomesFilters(user, gate, { scope: 'TEAM', teamId }, from, to) },
  });
  return summarizePullRequestOutcomes(rows);
}
