import type { Prisma, PrismaClient } from '@auto-swe/shared';
import {
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
  CHANNEL_TASK_TEMPLATE_NAME,
} from '@auto-swe/shared/lib/channelTask';
import type {
  MeNeedsYouItem,
  MeSummary,
  MeSummaryTeam,
  WorkflowRunStatus,
} from '@auto-swe/shared/types/api';
import { humanStepListWhere, humanStepMineScope, humanStepTeamScope } from './humanStepFilters.js';
import { groupRequestExecutions } from './requestExecutions.js';
import {
  memberRunScope,
  RUN_TEAM_SELECT,
  type RunTeamRow,
  repositoryLabel,
  repositoryOfRun,
  runListTeamScope,
  teamsOfRun,
} from './runTeamScope.js';
import { buildWorkflowRunVisibilityFilter, type VisibilityActor } from './runVisibility.js';
import { bindingBudgetStatuses } from './teamBudgetStatus.js';
import type { MaybeGate } from './tenantScope.js';

/** Items on the desk's list; `total` still counts every one. */
export const NEEDS_YOU_ITEM_CAP = 25;

const TITLE_MAX = 200;

/**
 * The work a desk query is bounded to, beside the caller's visibility and control filters: a run
 * term and the human-step term over the same runs. The personal desk reads every team the caller
 * belongs to; a team's overview reads one named team. Each narrows only.
 */
export interface DeskScope {
  run: Prisma.WorkflowRunWhereInput;
  step: Prisma.WorkflowHumanStepWhereInput;
}

/** The caller's own teams' work: the personal desk. */
export function memberDeskScope(user: VisibilityActor): DeskScope {
  return { run: memberRunScope(user), step: humanStepMineScope(user) };
}

/** One team's list scope (owned or shared): a team's overview. */
export function teamDeskScope(teamId: string): DeskScope {
  return { run: runListTeamScope(teamId), step: humanStepTeamScope(teamId) };
}

/**
 * The actionable human steps of a desk (the caller's by default, or one team's). The summary and
 * `GET /human-steps?actionable=true&mine=true` (or `&teamId=`) both read this scope, so a badge
 * and the list behind it cannot count different steps.
 */
export function deskHumanStepWhere(
  user: VisibilityActor,
  gate: MaybeGate,
  scope: DeskScope = memberDeskScope(user)
): Prisma.WorkflowHumanStepWhereInput {
  return {
    AND: [
      humanStepListWhere(user, gate, {
        actionable: true,
        answeredByMe: false,
        overdue: false,
        status: 'PENDING',
      }),
      scope.step,
    ],
  };
}

/** How far back the desk looks for the attempts of a request: failures and merges older than this are not listed. */
export const ATTEMPT_WINDOW_DAYS = 30;

/**
 * The runs the desk's work queries read: visible to the caller, on their teams' work, of a real
 * request (not a channel assistant or task run). The same exclusions as
 * `GET /workflow-runs/requests`, so the desk's running and queued counts agree with its list.
 */
export function deskRunTerms(
  user: VisibilityActor,
  gate: MaybeGate,
  scope: DeskScope
): Prisma.WorkflowRunWhereInput[] {
  return [
    buildWorkflowRunVisibilityFilter(user, gate),
    scope.run,
    {
      template: { name: { notIn: [CHANNEL_ASSISTANT_TEMPLATE_NAME, CHANNEL_TASK_TEMPLATE_NAME] } },
    },
    { workRequestId: { not: null } },
  ];
}

/**
 * Attempts the desk groups by request. The OR picks requests the caller made or launched an
 * attempt of; it narrows the request, never by who launched an attempt, because filtering
 * attempts by launcher would resurrect an old failure after someone else's successful retry. The
 * visibility, member-scope and age terms do narrow attempts, so "latest" means the latest the
 * caller can see within the window. A still-running attempt is read whatever its age.
 */
function deskAttemptWhere(
  user: VisibilityActor,
  gate: MaybeGate,
  now: number,
  scope: DeskScope
): Prisma.WorkflowRunWhereInput {
  return {
    AND: [
      ...deskRunTerms(user, gate, scope),
      {
        workRequest: {
          OR: [{ requestedById: user.sub }, { workflowRuns: { some: { launchedById: user.sub } } }],
        },
      },
      attemptWindowTerm(now),
    ],
  };
}

/** Attempts started inside the desk window, plus any still running whatever their age. */
export function attemptWindowTerm(now: number): Prisma.WorkflowRunWhereInput {
  const since = new Date(now - ATTEMPT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { OR: [{ startedAt: { gte: since } }, { status: 'RUNNING' }] };
}

/** Requests with a running attempt, on the caller's teams' work: what the team cards count. */
function deskRunningWhere(
  user: VisibilityActor,
  gate: MaybeGate,
  scope: DeskScope
): Prisma.WorkflowRunWhereInput {
  return {
    AND: [
      ...deskRunTerms(user, gate, scope),
      { workRequest: { workflowRuns: { some: { status: 'RUNNING' } } } },
    ],
  };
}

function clip(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, TITLE_MAX) : null;
}

export function requestTitle(
  workRequest: {
    description: string | null;
    externalTicketId: string | null;
    title: string | null;
  } | null
): string {
  return (
    clip(workRequest?.title) ??
    clip(workRequest?.description) ??
    clip(workRequest?.externalTicketId) ??
    'Untitled request'
  );
}

function placement(run: RunTeamRow) {
  const { owner } = teamsOfRun(run);
  return {
    repoName: repositoryLabel(repositoryOfRun(run)),
    teamId: owner?.id ?? null,
    teamName: owner?.name ?? null,
    teamSlug: owner?.slug ?? null,
  };
}

/** Most urgent first: due-soon approvals by deadline, then everything else newest first. */
function compareItems(a: MeNeedsYouItem, b: MeNeedsYouItem): number {
  const aDue = a.kind === 'approval_due_soon' ? a.dueAt : null;
  const bDue = b.kind === 'approval_due_soon' ? b.dueAt : null;
  if (aDue !== null && bDue !== null) {
    return aDue < bDue ? -1 : aDue > bDue ? 1 : b.occurredAt.localeCompare(a.occurredAt);
  }
  if (aDue !== null) {
    return -1;
  }
  if (bDue !== null) {
    return 1;
  }
  return b.occurredAt.localeCompare(a.occurredAt);
}

interface DeskDeps {
  dueSoonHours: number;
  gate: MaybeGate;
  prisma: PrismaClient;
  user: VisibilityActor;
}

type DeskEntry = { item: MeNeedsYouItem; teamIds: Set<string> };

/**
 * The caller's needs-you entries within a scope, de-duplicated by key, and the latest attempt of
 * each request in scope that has one running. The personal desk reads it over every team the
 * caller belongs to; a team's overview reads it over that one team, so the two cannot count
 * different things.
 */
export async function loadDeskEntries({
  dueSoonHours,
  gate,
  prisma,
  scope,
  user,
}: DeskDeps & { scope: DeskScope }): Promise<{
  deduped: DeskEntry[];
  running: (RunTeamRow & { id: string; status: string; workRequestId: string | null })[];
}> {
  const now = Date.now();
  const dueSoonUntil = now + dueSoonHours * 60 * 60 * 1000;

  const [steps, attempts, running] = await Promise.all([
    prisma.workflowHumanStep.findMany({
      select: {
        id: true,
        requestedAt: true,
        run: {
          select: {
            ...RUN_TEAM_SELECT,
            id: true,
            workRequest: {
              select: { ...RUN_TEAM_SELECT.workRequest.select, id: true },
            },
          },
        },
        runId: true,
        timeoutAt: true,
        title: true,
      },
      where: deskHumanStepWhere(user, gate, scope),
    }),
    prisma.workflowRun.findMany({
      distinct: ['workRequestId', 'connectionId'],
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        ...RUN_TEAM_SELECT,
        _count: { select: { humanSteps: { where: { status: 'PENDING' } } } },
        endedAt: true,
        id: true,
        launchedById: true,
        startedAt: true,
        status: true,
        workRequest: {
          select: {
            ...RUN_TEAM_SELECT.workRequest.select,
            activeWorkflows: {
              select: {
                ...RUN_TEAM_SELECT.workRequest.select.activeWorkflows.select,
                updatedAt: true,
              },
            },
            description: true,
            externalTicketId: true,
            id: true,
            requestedById: true,
            title: true,
          },
        },
        workRequestId: true,
      },
      where: deskAttemptWhere(user, gate, now, scope),
    }),
    // The latest attempt of each request/repository, as the request list reads them; the groups
    // below keep the ones still running.
    prisma.workflowRun.findMany({
      distinct: ['workRequestId', 'connectionId'],
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { ...RUN_TEAM_SELECT, id: true, status: true, workRequestId: true },
      where: deskRunningWhere(user, gate, scope),
    }),
  ]);

  // Each item with the teams it counts toward.
  const entries: DeskEntry[] = [];

  for (const step of steps) {
    const { teamIds } = teamsOfRun(step.run);
    const dueAt = step.timeoutAt;
    entries.push({
      item: {
        ...placement(step.run),
        dueAt: dueAt ? dueAt.toISOString() : null,
        key: step.id,
        kind: dueAt && dueAt.getTime() <= dueSoonUntil ? 'approval_due_soon' : 'approval',
        occurredAt: step.requestedAt.toISOString(),
        requestId: step.run.workRequest?.id ?? null,
        runId: step.runId,
        title: clip(step.title) ?? 'Approval needed',
      },
      teamIds,
    });
  }

  const rows = new Map(attempts.map((run) => [run.id, run]));
  for (const group of groupRequestExecutions(attempts)) {
    // Every failed attempt, not just the first: in a multi-repository request each belongs to the
    // person who launched it, and the first one need not be the caller's.
    for (const failedId of group.failedRunIds) {
      const failed = rows.get(failedId);
      // Only a failure of an attempt the caller launched is theirs to act on.
      if (failed && failed.launchedById === user.sub) {
        entries.push({
          item: {
            ...placement(failed),
            dueAt: null,
            key: failed.id,
            kind: 'failed_run',
            occurredAt: (failed.endedAt ?? failed.startedAt).toISOString(),
            requestId: failed.workRequestId,
            runId: failed.id,
            title: requestTitle(failed.workRequest),
          },
          teamIds: teamsOfRun(failed).teamIds,
        });
      }
    }
    for (const mergeId of group.mergeRunIds) {
      const merge = rows.get(mergeId);
      if (merge && merge.workRequest?.requestedById === user.sub) {
        const ledger = merge.workRequest.activeWorkflows.find(
          (row) => row.temporalWorkflowId === merge.workflowId
        );
        entries.push({
          item: {
            ...placement(merge),
            dueAt: null,
            key: merge.id,
            kind: 'pr_merge',
            occurredAt: (ledger?.updatedAt ?? merge.startedAt).toISOString(),
            requestId: merge.workRequestId,
            runId: merge.id,
            title: requestTitle(merge.workRequest),
          },
          teamIds: teamsOfRun(merge).teamIds,
        });
      }
    }
  }

  // One item per key, whichever source produced it first.
  const unique = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    if (!unique.has(entry.item.key)) {
      unique.set(entry.item.key, entry);
    }
  }
  const deduped = [...unique.values()];
  return { deduped, running };
}

/**
 * How many requests are running and how many of them are still queued, over the latest attempts
 * of a set of requests: the grouping the request list applies under `state=active`, the group
 * running when any of its executions is. Running plus queued is that list's total.
 */
export function countRunningRequests(
  running: {
    id: string;
    status: string;
    workflowId: string;
    workRequest: {
      activeWorkflows: { currentStatus: string; temporalWorkflowId: string }[];
      isCrossRepo: boolean;
    } | null;
    workRequestId: string | null;
  }[]
): { queued: number; running: number } {
  let runningCount = 0;
  let queuedCount = 0;
  const rows = new Map(running.map((run) => [run.id, run]));
  const executions = running.map((run) => ({
    ...run,
    _count: { humanSteps: 0 },
    status: run.status as WorkflowRunStatus,
  }));
  for (const group of groupRequestExecutions(executions)) {
    if (group.status !== 'RUNNING') {
      continue;
    }
    const run = rows.get(group.id);
    const ledger = run?.workRequest?.activeWorkflows.find(
      (row) => row.temporalWorkflowId === run?.workflowId
    );
    if (ledger?.currentStatus === 'STARTING') {
      queuedCount++;
    } else {
      runningCount++;
    }
  }
  return { queued: queuedCount, running: runningCount };
}

/**
 * Builds the caller's desk: their teams, and everything across them that is waiting on them.
 * One query per source (memberships, steps, latest attempts, running runs), each bucketed by team
 * in memory, never one query per team.
 */
export async function buildMeSummary({
  dueSoonHours,
  gate,
  prisma,
  user,
}: DeskDeps): Promise<MeSummary> {
  const memberships = await prisma.teamMembership.findMany({
    orderBy: { team: { name: 'asc' } },
    select: {
      role: true,
      team: {
        select: {
          id: true,
          name: true,
          organization: { select: { name: true } },
          orgId: true,
          slug: true,
        },
      },
    },
    where: { team: { isActive: true }, userId: user.sub },
  });
  if (memberships.length === 0) {
    return { needsYou: { items: [], total: 0 }, teams: [] };
  }
  const memberTeamIds = new Set(memberships.map((m) => m.team.id));
  const { deduped, running } = await loadDeskEntries({
    dueSoonHours,
    gate,
    prisma,
    scope: memberDeskScope(user),
    user,
  });

  const items = deduped
    .map((entry) => entry.item)
    .sort(compareItems)
    .slice(0, NEEDS_YOU_ITEM_CAP);

  const needsYou = new Map<string, number>();
  for (const { teamIds } of deduped) {
    for (const id of teamIds) {
      if (memberTeamIds.has(id)) {
        needsYou.set(id, (needsYou.get(id) ?? 0) + 1);
      }
    }
  }
  // Per member team, the same grouping the request list applies under `state=active`.
  const runningCount = new Map<string, number>();
  const queuedCount = new Map<string, number>();
  for (const teamId of memberTeamIds) {
    const counts = countRunningRequests(
      running.filter((run) => teamsOfRun(run).teamIds.has(teamId))
    );
    runningCount.set(teamId, counts.running);
    queuedCount.set(teamId, counts.queued);
  }

  // One read for every org and team the caller belongs to, never one per team: each team shows
  // the tighter of its own cap and its organization's.
  const budgets = await bindingBudgetStatuses(
    prisma,
    memberships.map((m) => ({ id: m.team.id, orgId: m.team.orgId }))
  );

  const teams: MeSummaryTeam[] = memberships.map(({ role, team }) => ({
    budget: budgets.get(team.id) ?? null,
    myRole: role,
    name: team.name,
    needsYou: needsYou.get(team.id) ?? 0,
    orgId: team.orgId,
    orgName: team.organization.name,
    queued: queuedCount.get(team.id) ?? 0,
    running: runningCount.get(team.id) ?? 0,
    slug: team.slug,
    teamId: team.id,
  }));

  return { needsYou: { items, total: deduped.length }, teams };
}
