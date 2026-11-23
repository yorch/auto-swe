import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { usdToCents } from '@auto-swe/shared/lib/billing';
import {
  CATALOG,
  can,
  isPlatformAdmin,
  isPlatformAdminRole,
  orgRankMeets,
  orgRankOf,
  teamRankMeets,
  teamRankOf,
  userActor,
} from '@auto-swe/shared/permissions';
import type {
  BudgetStatus,
  TeamOverview,
  TeamOverviewActivityItem,
  TeamOverviewRepo,
} from '@auto-swe/shared/types/api';
import { humanStepListWhere, humanStepTeamScope } from './humanStepFilters.js';
import {
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
import { loadUnownedFailures } from './teamAttention.js';
import { bindingBudgetStatuses } from './teamBudgetStatus.js';
import { countPendingTeamRequests } from './teamJoinRequests.js';
import { type MaybeGate, reachableConnections } from './tenantScope.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_LIMIT = 10;
/** Latest attempts read for the feed: more than shown, so statuses left out do not empty it. */
const ACTIVITY_READ = 50;
const REPO_LIMIT = 200;
const PR_WINDOW_DAYS = 30;
const LAST_WINDOW_DAYS = 7;

type ViewerLevel = TeamOverview['viewerLevel'];

/**
 * The overview as built here. `needsAdmin` is present, and `true`, only for a viewer who governs
 * the team (`team.members.manage`) when the team has no ADMIN; it is absent otherwise, never
 * `false` or `null`, like `lead` and `admin`.
 */
export type TeamOverviewView = TeamOverview & {
  needsAdmin?: true;
  /**
   * Join requests awaiting the team's own decision. Present only for a viewer who holds
   * `team.members.manage`, so a plain member's response has no such key.
   */
  pendingJoinRequests?: number;
};

interface OverviewDeps {
  dueSoonHours: number;
  gate: MaybeGate;
  prisma: PrismaClient;
  user: VisibilityActor;
}

type TeamAccess = TeamOverview['team']['access'];

/**
 * The view a team role gets. The platform role never decides it, except for an ADMIN outside the
 * team; an organization admin outside the team (`orgAdminOutside`, decided by the capability
 * resolver, never by a role compare here) gets the governance view as well.
 */
export function viewerLevelFor(
  teamRole: string | null,
  platformRole: string,
  orgAdminOutside = false
): ViewerLevel {
  const rank = teamRankOf(teamRole);
  if (rank === null) {
    return isPlatformAdminRole(platformRole) || orgAdminOutside ? 'admin' : 'member';
  }
  if (teamRankMeets(rank, 'ADMIN')) {
    return 'admin';
  }
  return teamRankMeets(rank, 'LEAD') ? 'lead' : 'member';
}

/** Whether the viewer holds the governance capability that appoints a team's members. */
async function viewerGovernsTeam(
  prisma: PrismaClient,
  user: VisibilityActor,
  teamId: string
): Promise<boolean> {
  return (await can(prisma, userActor(user), 'team.members.manage', { teamId })).allowed;
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

async function loadRepoRows(deps: OverviewDeps, team: { id: string }) {
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
          shares: { select: { canLaunch: true }, where: { teamId: team.id } },
          team: { select: { id: true, name: true, orgId: true } },
        },
        take: REPO_LIMIT,
        where: {
          AND: [
            isPlatformAdmin(user) ? {} : reachableConnections(user, gate),
            repositoryTeamScope(team.id),
            { isActive: true, type: 'git_repo' },
          ],
        },
      })
  );
  return rows;
}

/** The rows as the overview lists them; `budgets` holds each owning team's binding status. */
function toOverviewRepos(
  rows: Awaited<ReturnType<typeof loadRepoRows>>,
  teamId: string,
  budgets: Map<string, BudgetStatus>
): TeamOverviewRepo[] {
  return rows.map((row) => {
    const owned = row.team.id === teamId;
    // An owned repository is never view-only; a shared one is by this team's own share.
    const canLaunch = owned || row.shares.every((s) => s.canLaunch);
    return {
      canLaunch,
      id: row.id,
      // The owner's cap binds a launch, so a repository no one here can launch on carries none.
      launchBudget: owned || !canLaunch ? null : (budgets.get(row.team.id) ?? null),
      name: [row.organizationName, row.repoName].filter(Boolean).join('/') || (row.name ?? row.id),
      ownerTeamName: owned ? null : row.team.name,
      relation: owned ? 'owned' : 'shared',
    };
  });
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
 * How a caller reaches a team: as a member, as a platform ADMIN, or, without being a member, as an
 * organization admin of its organization (`team.read` held on organization authority). Null for
 * anyone else, whether or not the team exists, so a route answers all of them the same way.
 */
async function teamAccessOf(
  deps: OverviewDeps,
  team: { id: string },
  myRole: string | null
): Promise<TeamAccess | null> {
  if (myRole !== null) {
    return 'member';
  }
  if (isPlatformAdmin(deps.user)) {
    return 'platform-admin';
  }
  const decision = await can(deps.prisma, userActor(deps.user), 'team.read', { teamId: team.id });
  return decision.allowed && decision.authority === 'org-admin' ? 'org-admin' : null;
}

/**
 * The team overview. Null when the team does not exist or the caller is neither a member, a
 * platform ADMIN, nor an organization admin of the team's organization, so a route answers all of
 * those the same way. A non-member sees a governance view: every section that reads runs is built
 * with the caller's own visibility filter, so it holds nothing the caller could not already reach.
 *
 * The lead and admin sections are only queried, and only attached, for a viewer who may see them:
 * a lower role gets a response in which those keys do not exist.
 */
export async function buildTeamOverview(
  deps: OverviewDeps,
  teamId: string
): Promise<TeamOverviewView | null> {
  const { dueSoonHours, gate, prisma, user } = deps;
  const team = await prisma.team.findUnique({
    select: {
      id: true,
      isActive: true,
      memberships: { select: { role: true }, where: { userId: user.sub } },
      name: true,
      organization: { select: { name: true } },
      orgId: true,
      slug: true,
    },
    where: { id: teamId },
  });
  const myRole = team?.memberships[0]?.role ?? null;
  if (!team) {
    return null;
  }
  const access = await teamAccessOf(deps, team, myRole);
  if (access === null) {
    return null;
  }
  const viewerLevel = viewerLevelFor(myRole, user.role, access === 'org-admin');
  const now = Date.now();
  const scope = teamDeskScope(team.id);
  const terms = deskRunTerms(user, gate, scope);

  const [desk, recent, activity, pullRequests, repoData] = await Promise.all([
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
    // One batched budget read for the team and the owners of its shared repositories, whose caps
    // bind a launch on those repositories.
    loadRepoRows(deps, team).then(async (rows) => {
      const owners = new Map([[team.id, { id: team.id, orgId: team.orgId }]]);
      for (const row of rows) {
        if (!row.shares.every((s) => s.canLaunch)) {
          continue;
        }
        owners.set(row.team.id, { id: row.team.id, orgId: row.team.orgId });
      }
      return { budgets: await bindingBudgetStatuses(prisma, [...owners.values()]), rows };
    }),
  ]);
  const { budgets, rows: repoRows } = repoData;
  const repos = toOverviewRepos(repoRows, team.id, budgets);

  const counts = countRunningRequests(desk.running);
  // The caller's own share of the same rows, for "My work": the desk's own failed and merge items
  // (so the team page and the desk cannot disagree) and the running requests they launched.
  const mine = {
    failed: desk.deduped.filter((entry) => entry.item.kind === 'failed_run').length,
    prsAwaitingMerge: desk.deduped.filter((entry) => entry.item.kind === 'pr_merge').length,
    running: countRunningRequests(desk.running.filter((run) => run.launchedById === user.sub))
      .running,
  };
  const groups = groupRequestExecutions(recent);
  const overview: TeamOverviewView = {
    activity,
    budget: budgets.get(team.id) ?? null,
    last7d: {
      failed: groups.filter((g) => g.status === 'FAILED' || g.status === 'TIMED_OUT').length,
      started: groups.length,
      succeeded: groups.filter((g) => g.status === 'SUCCESS').length,
    },
    mine,
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
      access,
      id: team.id,
      myRole,
      name: team.name,
      orgId: team.orgId,
      orgName: team.organization.name,
      slug: team.slug,
    },
    viewerLevel,
  };

  // Whether the viewer holds `team.members.manage` (asked at most once). A team LEAD or ADMIN
  // holds it on an active team by their level, which needs no query. A plain member holds it only
  // through organization or platform authority, so one organization-membership read (against the
  // catalog's own organization rank for the capability) rules out nearly every member before the
  // full capability check, which is then left to the few it could allow.
  let governs: boolean | undefined;
  const viewerGoverns = async () => {
    if (governs !== undefined) {
      return governs;
    }
    if (team.isActive && viewerLevel !== 'member') {
      governs = true;
    } else if (isPlatformAdmin(user)) {
      governs = await viewerGovernsTeam(prisma, user, team.id);
    } else {
      const orgRow = await prisma.organizationMembership.findUnique({
        select: { role: true },
        where: { userId_orgId: { orgId: team.orgId, userId: user.sub } },
      });
      const needed = CATALOG['team.members.manage'].org;
      governs =
        !!orgRow &&
        !!needed &&
        orgRankMeets(orgRankOf(orgRow.role), needed) &&
        (await viewerGovernsTeam(prisma, user, team.id));
    }
    return governs;
  };

  // A team with no ADMIN (an organization removal may leave one) is flagged for those who can
  // appoint one. One read of the roles answers it for nearly every team; the capability is asked
  // only for a team that has none.
  const roles = await prisma.teamMembership.findMany({
    select: { role: true },
    where: { teamId: team.id },
  });
  if (!roles.some((m) => teamRankMeets(teamRankOf(m.role), 'ADMIN')) && (await viewerGoverns())) {
    overview.needsAdmin = true;
  }
  // The same people decide who joins, so they see how many are waiting: one indexed count.
  if (await viewerGoverns()) {
    overview.pendingJoinRequests = await countPendingTeamRequests(prisma, team.id);
  }

  if (viewerLevel === 'member') {
    return overview;
  }

  const [unownedFailures, staleApprovals, openPullRequests] = await Promise.all([
    loadUnownedFailures(deps, team.id, now).then((failures) => failures.length),
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
          isPlatformAdmin(user) ? {} : { repository: reachableConnections(user, gate) },
          { repository: repositoryTeamScope(team.id) },
          { status: 'OPEN' },
        ],
      },
    }),
  ]);
  const withLead: TeamOverviewView = {
    ...overview,
    lead: { openPullRequests, staleApprovals, unownedFailures },
  };
  if (viewerLevel === 'lead') {
    return withLead;
  }
  // The team's spend in dollars sits beside a percentage of a cap, and the two together give the
  // cap away. When the binding cap is the TEAM's own, it is the team ADMIN's to read (they set it
  // and read it at `GET /teams/:id/budget`), so the figure is attached. When it is the
  // organization's, the cap is an ORG_ADMIN's: the figure is attached only to one, and otherwise
  // the key is absent. With no cap at all there is nothing to give away.
  if (
    overview.budget !== null &&
    overview.budget.scope !== 'team' &&
    !(await can(prisma, userActor(user), 'org.budget.manage', { orgId: team.orgId })).allowed
  ) {
    return { ...withLead, admin: {} };
  }
  // A non-member organization admin's runs are filtered to the ones they may see, so a sum would
  // read as the team's spend and be far too low beside a real budget percentage: it is null.
  if (access === 'org-admin') {
    return { ...withLead, admin: { monthCostUsdCents: null } };
  }
  return { ...withLead, admin: { monthCostUsdCents: await monthCostCents(deps, team.id, now) } };
}
