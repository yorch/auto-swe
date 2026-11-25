import type { PrismaClient } from '@auto-swe/shared';
import type {
  CampaignAttemptDto,
  CampaignBlockedReason,
  CampaignCountsDto,
  CampaignProposalDto,
  CampaignTargetDelivery,
  CampaignTargetDto,
} from '@auto-swe/shared/lib/campaignApi';
import {
  type BlockReason,
  type CampaignGateValue,
  countTargets,
  decideSchedule,
  describeBlockReason,
  normalizeTargetState,
  type TargetState,
} from '@auto-swe/shared/lib/campaignState';
import { type PullRequestRepo, pullRequestUrl } from '@auto-swe/shared/lib/pullRequest';
import { resolveGitHubBaseUrl } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

/**
 * What the campaign routes read and shape for the dashboard: counts over the reconciler's target
 * states, each target's delivery detail (read from `PullRequest` through its latest attempt's run,
 * never copied onto the target), attempts, why a target waits, and the discovery proposals.
 *
 * Reads here are of rows the caller has already been authorized to see on the campaign; what a
 * non-admin may NAME is decided by the caller passing only the targets they can reach, and by the
 * masking of every other target's identity below.
 */

type Prisma = PrismaClient;

export function emptyCounts(): CampaignCountsDto {
  return countTargets([]);
}

/**
 * Per-campaign target counts for the campaigns on a page. Counts only: no repository identity
 * crosses, which is why the aggregate may run over targets the caller cannot reach.
 */
export async function countsFor(
  prisma: Prisma,
  campaignIds: string[]
): Promise<Map<string, CampaignCountsDto>> {
  const out = new Map<string, CampaignCountsDto>(campaignIds.map((id) => [id, emptyCounts()]));
  if (campaignIds.length === 0) {
    return out;
  }
  const rows = await runUnscoped(
    'aggregate counts only; identities are filtered separately',
    ['CampaignTarget'],
    () =>
      prisma.campaignTarget.groupBy({
        _count: { _all: true },
        by: ['campaignId', 'state'],
        where: { campaignId: { in: campaignIds } },
      })
  );
  const states = new Map<string, TargetState[]>();
  for (const row of rows) {
    const list = states.get(row.campaignId) ?? [];
    for (let i = 0; i < row._count._all; i += 1) {
      list.push(row.state as TargetState);
    }
    states.set(row.campaignId, list);
  }
  for (const [id, list] of states) {
    out.set(id, countTargets(list));
  }
  return out;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** A target row as the detail route selects it. */
export interface TargetRow {
  id: string;
  connectionId: string | null;
  repoLabel: string;
  position: number;
  state: string;
  path: string | null;
  verification: string | null;
  childWorkflowId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  failureReason: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  brief: string | null;
  dependsOn: string[];
  evidence: unknown;
  regressions: number;
  staleSince: Date | null;
  lastCheckedAt: Date | null;
  lastCheckedSha: string | null;
  connection?: (PullRequestRepo & { id?: string }) | null;
}

export const TARGET_SELECT = {
  brief: true,
  childWorkflowId: true,
  connection: { select: { githubUrl: true, organizationName: true, repoName: true } },
  connectionId: true,
  dependsOn: true,
  evidence: true,
  failureReason: true,
  finishedAt: true,
  id: true,
  lastCheckedAt: true,
  lastCheckedSha: true,
  path: true,
  position: true,
  prNumber: true,
  prUrl: true,
  regressions: true,
  repoLabel: true,
  staleSince: true,
  startedAt: true,
  state: true,
  verification: true,
} as const;

/** The minimum of every target of a campaign, for the block decision. Never leaves this module named. */
interface GraphNode {
  id: string;
  label: string;
  state: string;
  position: number;
  dependsOn: string[];
}

export async function loadGraph(prisma: Prisma, campaignId: string): Promise<GraphNode[]> {
  const rows = await runUnscoped(
    'the block decision reads every target of a campaign the caller may see; names are masked for targets they may not',
    ['CampaignTarget'],
    () =>
      prisma.campaignTarget.findMany({
        orderBy: { position: 'asc' },
        select: { dependsOn: true, id: true, position: true, repoLabel: true, state: true },
        where: { campaignId },
      })
  );
  return rows.map((r) => ({
    dependsOn: r.dependsOn,
    id: r.id,
    label: r.repoLabel,
    position: r.position,
    state: r.state,
  }));
}

function blockedReasonFor(
  reason: BlockReason,
  visible: ReadonlySet<string>,
  idOf: (r: BlockReason) => string | null
): CampaignBlockedReason {
  const upstreamId = idOf(reason);
  const named = upstreamId !== null && visible.has(upstreamId);
  const text = describeBlockReason(reason);
  return {
    kind: reason.kind,
    // A target the viewer cannot see is not named: the reason says only that it waits.
    text:
      upstreamId !== null && !named
        ? reason.kind === 'upstream-failed'
          ? 'An upstream repository you cannot see did not finish and needs a person'
          : 'Waiting for an upstream repository you cannot see'
        : text,
    upstreamId: named ? upstreamId : null,
    upstreamLabel:
      named && 'upstreamLabel' in reason
        ? (reason as { upstreamLabel: string }).upstreamLabel
        : null,
  };
}

const upstreamIdOf = (r: BlockReason): string | null =>
  'upstreamId' in r ? (r as { upstreamId: string }).upstreamId : null;

/**
 * The reason each `BLOCKED` target waits, from the same decision the scheduler takes. The campaign's
 * state is read as `ACTIVE` so a paused campaign still explains its blocked targets.
 */
export function blockedReasons(
  campaign: { gate: CampaignGateValue; maxParallel: number; maxOpenPullRequests: number | null },
  hasCheck: boolean,
  graph: GraphNode[],
  visible: ReadonlySet<string>
): Map<string, CampaignBlockedReason> {
  const decision = decideSchedule({
    campaignState: 'ACTIVE',
    gate: campaign.gate,
    hasCheck,
    maxOpenPullRequests: campaign.maxOpenPullRequests,
    maxParallel: campaign.maxParallel,
    targets: graph.map((n) => ({ ...n, state: n.state as TargetState })),
  });
  return new Map(
    decision.blocked.map((b) => [b.targetId, blockedReasonFor(b.reason, visible, upstreamIdOf)])
  );
}

/** Latest-attempt-first view of one target's attempts. */
interface AttemptRow {
  id: string;
  targetId: string;
  n: number;
  runId: string | null;
  childWorkflowId: string | null;
  path: string | null;
  verification: string | null;
  outcome: string | null;
  failureReason: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * The pull request each latest attempt opened, read from `PullRequest` by the attempt's run. A run
 * the attempt has not recorded yet (the worker writes `runId` once the run row exists) is found
 * through its workflow id, so a draft shows as soon as the run does.
 */
async function deliveries(
  prisma: Prisma,
  latest: AttemptRow[],
  repoOf: (targetId: string) => PullRequestRepo | null
): Promise<Map<string, CampaignTargetDelivery>> {
  const runIdByTarget = new Map<string, string>();
  const needRun = latest.filter((a) => !a.runId && a.childWorkflowId);
  const runsByWorkflow = new Map<string, string>();
  if (needRun.length > 0) {
    const runs = await prisma.workflowRun.findMany({
      select: { id: true, workflowId: true },
      where: { workflowId: { in: needRun.map((a) => a.childWorkflowId as string) } },
    });
    for (const run of runs) {
      runsByWorkflow.set(run.workflowId, run.id);
    }
  }
  for (const a of latest) {
    const runId = a.runId ?? (a.childWorkflowId ? runsByWorkflow.get(a.childWorkflowId) : null);
    if (runId) {
      runIdByTarget.set(a.targetId, runId);
    }
  }
  const out = new Map<string, CampaignTargetDelivery>();
  if (runIdByTarget.size === 0) {
    return out;
  }
  const prs = await prisma.pullRequest.findMany({
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    select: {
      ciStatus: true,
      isDraft: true,
      mergedAt: true,
      openedAt: true,
      prNumber: true,
      runId: true,
      status: true,
    },
    where: { runId: { in: [...new Set(runIdByTarget.values())] } },
  });
  const newestByRun = new Map<string, (typeof prs)[number]>();
  for (const pr of prs) {
    if (pr.runId && !newestByRun.has(pr.runId)) {
      newestByRun.set(pr.runId, pr);
    }
  }
  let base: string | null = null;
  for (const [targetId, runId] of runIdByTarget) {
    const pr = newestByRun.get(runId);
    if (!pr) {
      continue;
    }
    const repo = repoOf(targetId);
    let prUrl: string | null = null;
    if (repo && pr.prNumber !== null) {
      try {
        base = base ?? (await resolveGitHubBaseUrl());
        prUrl = pullRequestUrl(repo, pr.prNumber, base);
      } catch {
        prUrl = null;
      }
    }
    out.set(targetId, {
      ciStatus: pr.ciStatus,
      isDraft: pr.isDraft,
      mergedAt: iso(pr.mergedAt),
      openedAt: iso(pr.openedAt),
      prNumber: pr.prNumber,
      prUrl,
      status: pr.status as CampaignTargetDelivery['status'],
    });
  }
  return out;
}

export interface TargetViewInput {
  targets: TargetRow[];
  /** Ids of the targets the caller may see (every one passed in), for masking `dependsOn`. */
  blocked: Map<string, CampaignBlockedReason>;
}

/** The DTOs of the targets a caller may see. */
export async function targetDtos(
  prisma: Prisma,
  targets: TargetRow[],
  blocked: Map<string, CampaignBlockedReason>
): Promise<CampaignTargetDto[]> {
  if (targets.length === 0) {
    return [];
  }
  const attemptRows = (await prisma.campaignAttempt.findMany({
    orderBy: [{ targetId: 'asc' }, { n: 'asc' }],
    select: {
      childWorkflowId: true,
      failureReason: true,
      finishedAt: true,
      id: true,
      n: true,
      outcome: true,
      path: true,
      runId: true,
      startedAt: true,
      targetId: true,
      verification: true,
    },
    where: { targetId: { in: targets.map((t) => t.id) } },
  })) as AttemptRow[];
  const attemptsByTarget = new Map<string, AttemptRow[]>();
  for (const a of attemptRows) {
    const list = attemptsByTarget.get(a.targetId) ?? [];
    list.push(a);
    attemptsByTarget.set(a.targetId, list);
  }
  const latest = targets.flatMap((t) => {
    const list = attemptsByTarget.get(t.id);
    return list && list.length > 0 ? [list[list.length - 1] as AttemptRow] : [];
  });
  const repoByTarget = new Map(targets.map((t) => [t.id, t.connection ?? null]));
  const delivery = await deliveries(prisma, latest, (id) => repoByTarget.get(id) ?? null);

  const liveIds = targets
    .filter((t) => normalizeTargetState(t.state as TargetState) === 'RUNNING')
    .flatMap((t) => {
      const last = attemptsByTarget.get(t.id)?.at(-1);
      const id = last?.childWorkflowId ?? t.childWorkflowId;
      return id ? [id] : [];
    });
  const live =
    liveIds.length > 0
      ? await prisma.activeWorkflow.findMany({
          select: { currentStatus: true, temporalWorkflowId: true },
          where: { temporalWorkflowId: { in: liveIds } },
        })
      : [];
  const liveById = new Map(live.map((l) => [l.temporalWorkflowId, l.currentStatus]));
  const visibleIds = new Set(targets.map((t) => t.id));

  return targets.map((t) => {
    const attempts = attemptsByTarget.get(t.id) ?? [];
    const last = attempts.at(-1);
    const childWorkflowId = last?.childWorkflowId ?? t.childWorkflowId;
    const d = delivery.get(t.id) ?? null;
    const attemptDtos: CampaignAttemptDto[] = attempts.map((a) => ({
      childWorkflowId: a.childWorkflowId,
      failureReason: a.failureReason,
      finishedAt: iso(a.finishedAt),
      id: a.id,
      n: a.n,
      outcome: a.outcome as CampaignAttemptDto['outcome'],
      path: a.path as CampaignAttemptDto['path'],
      runId: a.runId,
      startedAt: a.startedAt.toISOString(),
      verification: a.verification as CampaignAttemptDto['verification'],
    }));
    return {
      attempts: attemptDtos,
      blockedReason: blocked.get(t.id) ?? null,
      brief: t.brief,
      childWorkflowId,
      connectionId: t.connectionId,
      delivery: d,
      dependsOn: t.dependsOn.filter((id) => visibleIds.has(id)),
      evidence:
        t.evidence && typeof t.evidence === 'object' && !Array.isArray(t.evidence)
          ? (t.evidence as Record<string, unknown>)
          : null,
      failureReason: last?.failureReason ?? t.failureReason,
      finishedAt: iso(last?.finishedAt ?? t.finishedAt),
      id: t.id,
      lastCheckedAt: iso(t.lastCheckedAt),
      lastCheckedSha: t.lastCheckedSha,
      liveStatus:
        normalizeTargetState(t.state as TargetState) === 'RUNNING' && childWorkflowId
          ? (liveById.get(childWorkflowId) ?? null)
          : null,
      path: (last?.path ?? t.path) as CampaignTargetDto['path'],
      position: t.position,
      prNumber: d?.prNumber ?? t.prNumber,
      prUrl: d?.prUrl ?? t.prUrl,
      regressions: t.regressions,
      repoLabel: t.repoLabel,
      staleSince: iso(t.staleSince),
      startedAt: iso(last?.startedAt ?? t.startedAt),
      state: t.state as CampaignTargetDto['state'],
      verification: (last?.verification ?? t.verification) as CampaignTargetDto['verification'],
    };
  });
}

/**
 * The discovery proposals of a campaign, for a viewer who may see the repositories they name.
 * A proposal names a repository the launcher could not start work in, often another team's: a
 * non-admin gets only the proposals whose repository they can reach (`reach`, the same predicate
 * the target list uses), and the rest are counted, never named. An ADMIN passes no predicate.
 */
export async function proposalDtos(
  prisma: Prisma,
  campaignId: string,
  reach?: Record<string, unknown>
): Promise<{ proposals: CampaignProposalDto[]; hiddenCount: number }> {
  const select = {
    connection: { select: { organizationName: true, repoName: true } },
    connectionId: true,
    createdAt: true,
    decidedAt: true,
    id: true,
    reason: true,
  } as const;
  const [rows, total] = await Promise.all([
    prisma.campaignProposal.findMany({
      orderBy: { createdAt: 'asc' },
      select,
      where: { campaignId, ...(reach ? { connection: reach } : {}) },
    }),
    reach ? prisma.campaignProposal.count({ where: { campaignId } }) : Promise.resolve(null),
  ]);
  return {
    hiddenCount: total === null ? 0 : Math.max(0, total - rows.length),
    proposals: rows.map((r) => ({
      connectionId: r.connectionId,
      createdAt: r.createdAt.toISOString(),
      decidedAt: iso(r.decidedAt),
      id: r.id,
      reason: r.reason,
      repoLabel:
        r.connection?.organizationName && r.connection.repoName
          ? `${r.connection.organizationName}/${r.connection.repoName}`
          : null,
    })),
  };
}
