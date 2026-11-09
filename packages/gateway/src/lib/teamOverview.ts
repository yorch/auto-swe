import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { usdToCents } from '@auto-swe/shared/lib/billing';
import type {
  TeamOverview,
  TeamOverviewActivityItem,
  TeamOverviewRepo,
} from '@auto-swe/shared/types/api';
import { humanStepListWhere, humanStepTeamScope } from './humanStepFilters.js';
import {
  attemptWindowTerm,
  countRunningRequests,
  deskRunTerms,
  loadDeskEntries,
  requestTitle,
  teamDeskScope,
} from './meSummary.js';
import { asPlatformAdmin } from './platformAdminScope.js';
import { teamPullRequestOutcomes } from './pullRequestOutcomesQuery.js';
import { groupRequestExecutions } from './requestExecutions.js';
import {
  RUN_TEAM_SELECT,
  repositoryLabel,
  repositoryOfRun,
  repositoryTeamScope,
  runMetricsTeamScope,
} from './runTeamScope.js';
import { buildWorkflowRunVisibilityFilter, type VisibilityActor } from './runVisibility.js';
import { type MaybeGate, reachableConnections } from './tenantScope.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_LIMIT = 10;
/** Latest attempts read for the feed: more than shown, so statuses left out do not empty it. */
const ACTIVITY_READ = 50;
const REPO_LIMIT = 200;
const PR_WINDOW_DAYS = 30;
const LAST_WINDOW_DAYS = 7;

type ViewerLevel = TeamOverview['viewerLevel'];

interface OverviewDeps {
  dueSoonHours: number;
  gate: MaybeGate;
  prisma: PrismaClient;
  user: VisibilityActor;
}

/** The view a team role gets. The platform role never decides it, except for an ADMIN outside the team. */
export function viewerLevelFor(
  teamRole: 'ADMIN' | 'LEAD' | 'ENGINEER' | null,
  platformRole: string
): ViewerLevel {
  if (teamRole === null) {
    return platformRole === 'ADMIN' ? 'admin' : 'engineer';
  }
  return teamRole === 'ADMIN' ? 'admin' : teamRole === 'LEAD' ? 'lead' : 'engineer';
}

function startOfMonthUtc(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** The latest attempt of each request on the team's work, within a window, as the lists read them. */
function latestAttempts(prisma: PrismaClient, where: Prisma.WorkflowRunWhereInput, take?: number) {
  return prisma.workflowRun.findMany({
    distinct: ['workRequestId', 'connectionId'],
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: {
      _count: { select: { humanSteps: { where: { status: 'PENDING' } } } },
      id: true,
      launchedById: true,
      status: true,
      workflowId: true,
      workRequest: {
        select: {
          activeWorkflows: { select: { currentStatus: true, temporalWorkflowId: true } },
          isCrossRepo: true,
        },
      },
      workRequestId: true,
    },
    ...(take ? { take } : {}),
    where,
  });
}

async function loadActivity(
  deps: OverviewDeps,
  where: Prisma.WorkflowRunWhereInput
): Promise<TeamOverviewActivityItem[]> {
  const { gate, prisma, user } = deps;
  const rows = await prisma.workflowRun.findMany({
    distinct: ['workRequestId', 'connectionId'],
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: {
      ...RUN_TEAM_SELECT,
      _count: { select: { humanSteps: { where: { status: 'PENDING' } } } },
      endedAt: true,
      id: true,
      launchedBy: { select: { name: true } },
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
    take: ACTIVITY_READ,
    where,
  });
  // `_count.humanSteps` counts steps the caller may merely see. "Needs attention" means waiting
  // on them, as the request list's state does, so only runs with a step they can answer (the
  // control filter, which also leaves out answered and expired steps) are in attention.
  const candidateRunIds = rows.filter((run) => run._count.humanSteps > 0).map((run) => run.id);
  const controlledRunIds = new Set<string>();
  if (candidateRunIds.length > 0) {
    const steps = await prisma.workflowHumanStep.findMany({
      select: { runId: true },
      where: {
        AND: [
          humanStepListWhere(user, gate, {
            actionable: true,
            answeredByMe: false,
            overdue: false,
            status: 'PENDING',
          }),
          { runId: { in: candidateRunIds } },
        ],
      },
    });
    for (const step of steps) {
      controlledRunIds.add(step.runId);
    }
  }
  const items: TeamOverviewActivityItem[] = [];
  const seen = new Set<string>();
  for (const run of rows) {
    // A multi-repository request has one latest attempt per repository: list it once.
    const key = run.workRequestId ?? run.id;
    if (seen.has(key)) {
      continue;
    }
    let state: TeamOverviewActivityItem['state'];
    if (run.status === 'RUNNING') {
      const awaitingMerge = run.workRequest?.activeWorkflows.some(
        (ledger) =>
          ledger.temporalWorkflowId === run.workflowId &&
          ledger.currentStatus === 'AWAITING_HUMAN_MERGE'
      );
      state = controlledRunIds.has(run.id) || awaitingMerge ? 'attention' : 'active';
    } else if (run.status === 'SUCCESS') {
      state = 'success';
    } else if (run.status === 'FAILED' || run.status === 'TIMED_OUT') {
      state = 'failed';
    } else {
      continue;
    }
    seen.add(key);
    items.push({
      launchedByName: run.launchedBy?.name ?? null,
      occurredAt: (run.endedAt ?? run.startedAt).toISOString(),
      repoName: repositoryLabel(repositoryOfRun(run)),
      requestId: run.workRequestId,
      runId: run.id,
      state,
      title: requestTitle(run.workRequest),
    });
    if (items.length === ACTIVITY_LIMIT) {
      break;
    }
  }
  return items;
}

async function loadRepos(deps: OverviewDeps, team: { id: string }): Promise<TeamOverviewRepo[]> {
  const { gate, prisma, user } = deps;
  const rows = await asPlatformAdmin(
    user,
    "admin names any team's repositories",
    ['Connection'],
    () =>
      prisma.connection.findMany({
        orderBy: { repoName: 'asc' },
        select: {
          id: true,
          name: true,
          organizationName: true,
          repoName: true,
          team: { select: { id: true, name: true } },
        },
        take: REPO_LIMIT,
        where: {
          AND: [
            user.role === 'ADMIN' ? {} : reachableConnections(user, gate),
            repositoryTeamScope(team.id),
            { isActive: true, type: 'git_repo' },
          ],
        },
      })
  );
  return rows.map((row) => {
    const owned = row.team.id === team.id;
    return {
      id: row.id,
      name: [row.organizationName, row.repoName].filter(Boolean).join('/') || (row.name ?? row.id),
      ownerTeamName: owned ? null : row.team.name,
      relation: owned ? 'owned' : 'shared',
    };
  });
}

/** Failed latest attempts on the team's work whose launcher is not a current member (or is unknown). */
async function countUnownedFailures(
  deps: OverviewDeps,
  teamId: string,
  now: number
): Promise<number> {
  const { gate, prisma, user } = deps;
  const [attempts, members] = await Promise.all([
    latestAttempts(prisma, {
      AND: [...deskRunTerms(user, gate, teamDeskScope(teamId)), attemptWindowTerm(now)],
    }),
    prisma.teamMembership.findMany({ select: { userId: true }, where: { teamId } }),
  ]);
  const memberIds = new Set(members.map((m) => m.userId));
  const launcherOf = new Map(attempts.map((run) => [run.id, run.launchedById]));
  let count = 0;
  for (const group of groupRequestExecutions(attempts)) {
    for (const failedId of group.failedRunIds) {
      const launcher = launcherOf.get(failedId);
      if (!launcher || !memberIds.has(launcher)) {
        count++;
      }
    }
  }
  return count;
}

async function monthCostCents(
  deps: OverviewDeps,
  teamId: string,
  now: number
): Promise<number | null> {
  const { gate, prisma, user } = deps;
  try {
    const sum = await prisma.workflowRun.aggregate({
      _sum: { costUsdAccrued: true },
      where: {
        AND: [
          buildWorkflowRunVisibilityFilter(user, gate),
          // Owner-attributed, so a repository shared to another team adds nothing to it.
          runMetricsTeamScope(teamId),
          { startedAt: { gte: startOfMonthUtc(now) } },
        ],
      },
    });
    return usdToCents(sum._sum.costUsdAccrued ?? 0);
  } catch {
    return null;
  }
}

/**
 * The team overview. Null when the team does not exist or the caller is neither a member nor a
 * platform ADMIN, so a route answers both the same way.
 *
 * The lead and admin sections are only queried, and only attached, for a viewer who may see them:
 * a lower role gets a response in which those keys do not exist.
 */
export async function buildTeamOverview(
  deps: OverviewDeps,
  teamId: string
): Promise<TeamOverview | null> {
  const { dueSoonHours, gate, prisma, user } = deps;
  const team = await prisma.team.findUnique({
    select: {
      id: true,
      memberships: { select: { role: true }, where: { userId: user.sub } },
      name: true,
      organization: { select: { name: true } },
      orgId: true,
      slug: true,
    },
    where: { id: teamId },
  });
  const myRole = team?.memberships[0]?.role ?? null;
  if (!team || (myRole === null && user.role !== 'ADMIN')) {
    return null;
  }
  const viewerLevel = viewerLevelFor(myRole, user.role);
  const now = Date.now();
  const scope = teamDeskScope(team.id);
  const terms = deskRunTerms(user, gate, scope);

  const [desk, recent, activity, pullRequests, repos] = await Promise.all([
    loadDeskEntries({ dueSoonHours, gate, prisma, scope, user }),
    latestAttempts(prisma, {
      AND: [...terms, { startedAt: { gte: new Date(now - LAST_WINDOW_DAYS * DAY_MS) } }],
    }),
    loadActivity(deps, { AND: terms }),
    teamPullRequestOutcomes(
      prisma,
      user,
      gate,
      team.id,
      new Date(now - PR_WINDOW_DAYS * DAY_MS),
      new Date(now)
    ),
    loadRepos(deps, team),
  ]);

  const counts = countRunningRequests(desk.running);
  const groups = groupRequestExecutions(recent);
  const overview: TeamOverview = {
    activity,
    last7d: {
      failed: groups.filter((g) => g.status === 'FAILED' || g.status === 'TIMED_OUT').length,
      started: groups.length,
      succeeded: groups.filter((g) => g.status === 'SUCCESS').length,
    },
    needsYou: { total: desk.deduped.length },
    pullRequests: {
      closedUnmerged: pullRequests.closedUnmerged,
      merged: pullRequests.merged,
      mergeRate: pullRequests.mergeRate,
      opened: pullRequests.opened,
      timeToMergeP50Hours:
        pullRequests.timeToMergeMs.p50 === null
          ? null
          : pullRequests.timeToMergeMs.p50 / (60 * 60 * 1000),
    },
    queued: counts.queued,
    repos,
    running: counts.running,
    team: {
      id: team.id,
      myRole,
      name: team.name,
      orgId: team.orgId,
      orgName: team.organization.name,
      slug: team.slug,
    },
    viewerLevel,
  };

  if (viewerLevel === 'engineer') {
    return overview;
  }

  const [unownedFailures, staleApprovals, openPullRequests] = await Promise.all([
    countUnownedFailures(deps, team.id, now),
    prisma.workflowHumanStep.count({
      where: {
        AND: [
          // Visibility, not control: the pending steps the caller may see, past their deadline.
          humanStepListWhere(user, gate, {
            actionable: false,
            answeredByMe: false,
            overdue: true,
            status: 'PENDING',
          }),
          humanStepTeamScope(team.id),
        ],
      },
    }),
    prisma.pullRequest.count({
      where: {
        AND: [
          user.role === 'ADMIN' ? {} : { repository: reachableConnections(user, gate) },
          { repository: repositoryTeamScope(team.id) },
          { status: 'OPEN' },
        ],
      },
    }),
  ]);
  const withLead: TeamOverview = {
    ...overview,
    lead: { openPullRequests, staleApprovals, unownedFailures },
  };
  if (viewerLevel === 'lead') {
    return withLead;
  }
  return { ...withLead, admin: { monthCostUsdCents: await monthCostCents(deps, team.id, now) } };
}
