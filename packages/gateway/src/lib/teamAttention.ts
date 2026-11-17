import type { PrismaClient } from '@auto-swe/shared';
import type { TeamAttentionFailure } from '@auto-swe/shared/types/api';
import { attemptWindowTerm, deskRunTerms, requestTitle, teamDeskScope } from './meSummary.js';
import { groupRequestExecutions } from './requestExecutions.js';
import { RUN_TEAM_SELECT, repositoryLabel, repositoryOfRun } from './runTeamScope.js';
import type { VisibilityActor } from './runVisibility.js';
import type { MaybeGate } from './tenantScope.js';

interface AttentionDeps {
  gate: MaybeGate;
  prisma: PrismaClient;
  user: VisibilityActor;
}

/**
 * The unowned failures of a team's work: failed latest attempts, within the desk window and as
 * visible to the caller, whose launcher is no longer a member of the team (or is unknown) and
 * which no lead has assigned yet. Newest first. The overview's count and the attention list both
 * read this, so they cannot disagree.
 */
export async function loadUnownedFailures(
  deps: AttentionDeps,
  teamId: string,
  now: number
): Promise<TeamAttentionFailure[]> {
  const { gate, prisma, user } = deps;
  const [attempts, members] = await Promise.all([
    prisma.workflowRun.findMany({
      distinct: ['workRequestId', 'connectionId'],
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        ...RUN_TEAM_SELECT,
        _count: { select: { humanSteps: { where: { status: 'PENDING' } } } },
        endedAt: true,
        failureAssignment: { select: { id: true } },
        id: true,
        launchedBy: { select: { name: true } },
        launchedById: true,
        startedAt: true,
        status: true,
        workRequest: {
          select: {
            ...RUN_TEAM_SELECT.workRequest.select,
            description: true,
            externalTicketId: true,
            id: true,
            title: true,
          },
        },
        workRequestId: true,
      },
      where: {
        AND: [...deskRunTerms(user, gate, teamDeskScope(teamId)), attemptWindowTerm(now)],
      },
    }),
    prisma.teamMembership.findMany({ select: { userId: true }, where: { teamId } }),
  ]);
  const memberIds = new Set(members.map((m) => m.userId));
  const rows = new Map(attempts.map((run) => [run.id, run]));
  const failures: { at: number; failure: TeamAttentionFailure }[] = [];
  for (const group of groupRequestExecutions(attempts)) {
    for (const failedId of group.failedRunIds) {
      const run = rows.get(failedId);
      if (!run || run.failureAssignment) {
        continue;
      }
      if (run.launchedById && memberIds.has(run.launchedById)) {
        continue;
      }
      const at = (run.endedAt ?? run.startedAt).getTime();
      failures.push({
        at,
        failure: {
          failedAt: new Date(at).toISOString(),
          formerLauncherName: run.launchedBy?.name ?? null,
          repoName: repositoryLabel(repositoryOfRun(run)) ?? '',
          requestId: run.workRequestId,
          runId: run.id,
          title: requestTitle(run.workRequest),
        },
      });
    }
  }
  return failures.sort((a, b) => b.at - a.at).map((entry) => entry.failure);
}
