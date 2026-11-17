import type { PrismaClient } from '@auto-swe/shared';
import type { TeamAttentionFailure } from '@auto-swe/shared/types/api';
import { attemptWindowTerm, deskRunTerms, requestTitle } from './meSummary.js';
import { groupRequestExecutions } from './requestExecutions.js';
import {
  RUN_TEAM_SELECT,
  repositoryLabel,
  repositoryOfRun,
  runMetricsTeamScope,
} from './runTeamScope.js';
import type { VisibilityActor } from './runVisibility.js';
import type { MaybeGate } from './tenantScope.js';

interface AttentionDeps {
  gate: MaybeGate;
  prisma: PrismaClient;
  user: VisibilityActor;
}

/** An unowned failure, with the assignment that lapsed on it (its assignee is gone), if any. */
export interface UnownedFailure {
  failure: TeamAttentionFailure;
  staleAssignment: { assigneeId: string; id: string; teamId: string } | null;
}

/**
 * The unowned failures of the runs a team OWNS: failed latest attempts, within the desk window
 * and as visible to the caller, whose launcher is unknown or no longer an active member of the
 * team, and which no active member has been assigned. An assignment lapses with its assignee's
 * membership. Newest first. The overview's count and the attention list both read this, so they
 * cannot disagree.
 */
export async function loadUnownedFailureEntries(
  deps: AttentionDeps,
  teamId: string,
  now: number
): Promise<UnownedFailure[]> {
  const { gate, prisma, user } = deps;
  const [attempts, members] = await Promise.all([
    prisma.workflowRun.findMany({
      distinct: ['workRequestId', 'connectionId'],
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        ...RUN_TEAM_SELECT,
        _count: { select: { humanSteps: { where: { status: 'PENDING' } } } },
        endedAt: true,
        failureAssignment: { select: { assigneeId: true, id: true, teamId: true } },
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
        AND: [
          // Owner-attributed: a repository merely shared to the team is not its work to own.
          ...deskRunTerms(user, gate, { run: runMetricsTeamScope(teamId), step: {} }),
          attemptWindowTerm(now),
        ],
      },
    }),
    // A deactivated user keeps their membership rows, so only active ones count.
    prisma.teamMembership.findMany({
      select: { userId: true },
      where: { teamId, user: { isActive: true } },
    }),
  ]);
  const memberIds = new Set(members.map((m) => m.userId));
  const rows = new Map(attempts.map((run) => [run.id, run]));
  const failures: { at: number; entry: UnownedFailure }[] = [];
  for (const group of groupRequestExecutions(attempts)) {
    for (const failedId of group.failedRunIds) {
      const run = rows.get(failedId);
      if (!run) {
        continue;
      }
      const assignment = run.failureAssignment;
      const assignmentHolds =
        assignment !== null && assignment.teamId === teamId && memberIds.has(assignment.assigneeId);
      if (assignmentHolds || (run.launchedById && memberIds.has(run.launchedById))) {
        continue;
      }
      const at = (run.endedAt ?? run.startedAt).getTime();
      failures.push({
        at,
        entry: {
          failure: {
            failedAt: new Date(at).toISOString(),
            formerLauncherName: run.launchedBy?.name ?? null,
            launchedByAutomation: run.launchedById === null,
            repoName: repositoryLabel(repositoryOfRun(run)) ?? '',
            requestId: run.workRequestId,
            runId: run.id,
            title: requestTitle(run.workRequest),
          },
          staleAssignment: assignment,
        },
      });
    }
  }
  return failures.sort((a, b) => b.at - a.at).map((item) => item.entry);
}

/** The failures of {@link loadUnownedFailureEntries}, without the lapsed-assignment detail. */
export async function loadUnownedFailures(
  deps: AttentionDeps,
  teamId: string,
  now: number
): Promise<TeamAttentionFailure[]> {
  const entries = await loadUnownedFailureEntries(deps, teamId, now);
  return entries.map((entry) => entry.failure);
}
