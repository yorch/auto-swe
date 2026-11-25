import type { Prisma } from '@auto-swe/shared';
import { resolveSettings } from '@auto-swe/shared/config';
import { orgMonthSpend, teamMonthSpend } from '@auto-swe/shared/lib/billing';
import {
  APPROVAL_STATUSES,
  CHILD_STATUSES,
  ChildResultSchema,
  type ChildStatus,
  isAttachRequestPending,
  MESSAGE_KINDS,
  MESSAGE_ROLES,
  ORCHESTRATION_STATUSES,
  type ParsedScope,
  parsePathScope,
} from '@auto-swe/shared/lib/orchestration';
import type {
  OrchestrationApprovalDto,
  OrchestrationChildDto,
  OrchestrationDetailDto,
  OrchestrationMessageDto,
  OrchestrationSummaryDto,
} from '@auto-swe/shared/lib/orchestrationApi';
import { canTeamLaunchOnRepo, repoMemberWhere } from '@auto-swe/shared/lib/repoMembership';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { OrchestrationPins } from './orchestrationInput.js';

/** Statuses in which an orchestration accepts work and its token is valid. */
export const ORCHESTRATION_LIVE_STATUSES = ['ACTIVE', 'WAITING'] as const;
/** A child in one of these holds a concurrency slot and reserves its writer path scopes. */
export const CHILD_LIVE_STATUSES = ['STARTING', 'RUNNING'] as const;

export const PinsSchema = z.object({
  maxChildren: z.number().int(),
  maxConcurrentChildren: z.number().int(),
  maxTurns: z.number().int(),
  maxWallClockSeconds: z.number().int(),
  maxWriterChildren: z.number().int(),
});

/** The bounds the workflow decides on, read once at launch from the registry. */
export async function resolvePins(ctx: {
  orgId?: string;
  teamId: string;
}): Promise<OrchestrationPins> {
  const s = await resolveSettings(
    [
      'orchestration.maxChildren',
      'orchestration.maxConcurrentChildren',
      'orchestration.maxTurns',
      'orchestration.maxWallClockSeconds',
      'orchestration.maxWriterChildren',
    ],
    ctx
  );
  return {
    maxChildren: s['orchestration.maxChildren'],
    maxConcurrentChildren: s['orchestration.maxConcurrentChildren'],
    maxTurns: s['orchestration.maxTurns'],
    maxWallClockSeconds: s['orchestration.maxWallClockSeconds'],
    maxWriterChildren: s['orchestration.maxWriterChildren'],
  };
}

/**
 * The launch-time snapshot of the bounds, stored in the orchestrator's own work request payload
 * (`{ orchestrationId, pinned }`); an orchestration has no `WorkflowRun` to pin on. Spawn
 * validation reads this, never the live registry, so it agrees with the workflow's own copy.
 */
export async function storedPins(
  workRequest: { payload: unknown } | null | undefined,
  ctx: { orgId?: string; teamId: string }
): Promise<OrchestrationPins> {
  const payload = workRequest?.payload as { pinned?: unknown } | null | undefined;
  const parsed = PinsSchema.safeParse(payload?.pinned);
  return parsed.success ? parsed.data : resolvePins(ctx);
}

export function refusal(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ code, error: { code, message }, message });
}

// ── Cursor: opaque, createdAt + id ──────────────────────────────────────────

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

const CURSOR_ID = z.uuid();

/** The id half must be a UUID: it is compared with a `@db.Uuid` column, where text is a 500. */
export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso ?? '');
    return id && CURSOR_ID.safeParse(id).success && !Number.isNaN(createdAt.getTime())
      ? { createdAt, id }
      : null;
  } catch {
    return null;
  }
}

// ── Who may see repository-derived data ──────────────────────────────────────

/**
 * The person asking. A repository attached to an orchestration may belong to a team other than
 * the one the orchestration names, so seeing the orchestration is not seeing the repository.
 */
export interface Viewer {
  admin: boolean;
  /** The person's id; empty for a service principal, which is identified by `serviceId`. */
  sub: string;
  /** Set when the viewer is a service principal: it is the launcher of its own orchestrations. */
  serviceId?: string;
}

/** Whether the viewer is the launcher of the row: the person, or the service principal. */
export function launchedByViewer(
  viewer: Viewer,
  row: { launchedById: string | null; serviceId?: string | null }
): boolean {
  return viewer.serviceId
    ? row.serviceId === viewer.serviceId
    : row.launchedById !== null && row.launchedById === viewer.sub;
}

/**
 * Which of `repoIds` the viewer may see the contents of: all of them for an ADMIN, otherwise the
 * ones they are a member of (owning team or a shared team). The launcher is handled by the caller
 * (their own orchestration), not here.
 */
export async function reachableRepoIds(
  prisma: Db,
  viewer: Viewer,
  repoIds: string[]
): Promise<Set<string>> {
  const ids = [...new Set(repoIds)];
  if (ids.length === 0) {
    return new Set();
  }
  if (viewer.admin) {
    return new Set(ids);
  }
  if (viewer.serviceId) {
    return servicePrincipalReach(prisma, viewer.serviceId, ids);
  }
  const rows = await runUnscoped(
    'repository reach is membership of the owning team or a team it is shared with, which is scoped to the viewer, not to one tenant',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: { id: true },
        where: { id: { in: ids }, ...repoMemberWhere({ userId: viewer.sub }) },
      })
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Which of `repoIds` a service principal reaches NOW: still on its allowlist, and its team still
 * owns the repository or has it shared for launching (the rule `authorizeServiceLaunch` applies).
 * A grant edited after launch ends the principal's view of what the repository produced.
 */
async function servicePrincipalReach(
  prisma: Db,
  serviceId: string,
  repoIds: string[]
): Promise<Set<string>> {
  const sp = await runUnscoped(
    "a principal's reach is its own allowlist and team, read by its own id",
    ['ServicePrincipal'],
    () =>
      prisma.servicePrincipal.findUnique({
        select: { connectionIds: true, disabledAt: true, teamId: true },
        where: { id: serviceId },
      })
  );
  if (!sp || sp.disabledAt) {
    return new Set();
  }
  const allowed = repoIds.filter((id) => sp.connectionIds.includes(id));
  if (allowed.length === 0) {
    return new Set();
  }
  const rows = await runUnscoped(
    'repository reach for a principal is its team owning or being shared the repository',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: { id: true, shares: { select: { canLaunch: true, teamId: true } }, teamId: true },
        where: { id: { in: allowed } },
      })
  );
  return new Set(rows.filter((r) => canTeamLaunchOnRepo(r, sp.teamId)).map((r) => r.id));
}

/**
 * Whether the viewer is a person who launched the row, and so sees its repository data without a
 * reach check. A service principal never takes this shortcut: its reach is read afresh.
 */
export function launcherSeesRepo(
  viewer: Viewer,
  row: { launchedById: string | null; serviceId?: string | null }
): boolean {
  return !viewer.serviceId && launchedByViewer(viewer, row);
}

/** Whether the viewer sees repository-derived data of an orchestration (children's results, ...). */
export async function canSeeRepoData(
  prisma: Db,
  viewer: Viewer,
  row: { launchedById: string | null; repoId: string | null; serviceId?: string | null }
): Promise<boolean> {
  if (!row.repoId || viewer.admin || launcherSeesRepo(viewer, row)) {
    return true;
  }
  return (await reachableRepoIds(prisma, viewer, [row.repoId])).has(row.repoId);
}

export const WITHHELD_RESULT = 'The result is withheld: it may contain repository content.';

/** The fixed body of a message withheld from a viewer who cannot reach the attached repository. */
export const WITHHELD_MESSAGE =
  'Withheld: this part of the conversation involves a repository you cannot access.';

/**
 * A per-turn marker row the worker writes for its own bookkeeping (`payload.hidden === true`).
 * It stays in the database and is never served: not in the transcript, not in the stream.
 */
export function isHiddenMessage(m: { payload: unknown }): boolean {
  const p = m.payload;
  return (
    !!p && typeof p === 'object' && !Array.isArray(p) && (p as { hidden?: unknown }).hidden === true
  );
}

/**
 * A transcript message as a viewer who cannot reach the repository sees it.
 *
 * Withheld whole (fixed body, payload `{ withheld: true }`): every orchestrator message, because
 * the orchestrator writes after it has read full child results, and every NOTICE from the moment
 * the repository was attached, because a notice can quote repository data. A child's result is
 * withheld too. What is served as it was: the launcher's and users' own words, and everything
 * written before the attach (no repository data existed in the conversation then).
 */
export function redactMessage(
  m: OrchestrationMessageDto,
  repoAttachedAt: Date | string | null = null
): OrchestrationMessageDto {
  const attachedMs = repoAttachedAt ? new Date(repoAttachedAt).getTime() : Number.NaN;
  const afterAttach = !Number.isNaN(attachedMs) && new Date(m.createdAt).getTime() >= attachedMs;
  if (m.role === 'ORCHESTRATOR' || (m.kind === 'NOTICE' && afterAttach)) {
    return { ...m, body: WITHHELD_MESSAGE, payload: { withheld: true } };
  }
  if (m.kind !== 'CHILD_RESULT') {
    return m;
  }
  const status = m.payload && typeof m.payload.status === 'string' ? m.payload.status : undefined;
  return {
    ...m,
    body: WITHHELD_RESULT,
    payload: {
      childId: m.childId ?? (m.payload?.childId as string | undefined) ?? null,
      ...(status ? { status } : {}),
    },
  };
}

// ── Views ───────────────────────────────────────────────────────────────────

export function messageView(row: {
  authorId: string | null;
  body: string;
  childId: string | null;
  createdAt: Date;
  id: string;
  kind: string;
  payload: unknown;
  role: string;
}): OrchestrationMessageDto {
  return {
    authorId: row.authorId,
    body: row.body,
    childId: row.childId,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    kind: (MESSAGE_KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as OrchestrationMessageDto['kind'])
      : 'NOTICE',
    payload:
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : null,
    role: (MESSAGE_ROLES as readonly string[]).includes(row.role)
      ? (row.role as OrchestrationMessageDto['role'])
      : 'SYSTEM',
  };
}

const isOneOf = <T extends string>(list: readonly T[], v: string, fallback: T): T =>
  (list as readonly string[]).includes(v) ? (v as T) : fallback;

export function approvalView(
  row: {
    argumentsDigest: string;
    childId: string | null;
    connectionId: string;
    createdAt: Date;
    expiresAt: Date;
    id: string;
    status: string;
    toolName: string;
  },
  connectionNames: Map<string, string | null>
): OrchestrationApprovalDto {
  return {
    argumentsDigest: row.argumentsDigest,
    childId: row.childId,
    connectionId: row.connectionId,
    connectionName: connectionNames.get(row.connectionId) ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    id: row.id,
    status: isOneOf(APPROVAL_STATUSES, row.status, 'PENDING'),
    toolName: row.toolName,
  };
}

interface ChildRow {
  agentKey: string;
  costUsd: number;
  createdAt: Date;
  endedAt: Date | null;
  id: string;
  label: string;
  pathScopes: string[];
  resultJson: unknown;
  role: 'READER' | 'WRITER';
  runId: string | null;
  status: string;
  workRequest?: {
    activeWorkflows?: Array<{ assignedBranch: string | null; costUsdAccrued: number }>;
  } | null;
  workRequestId: string;
}

export function childView(
  row: ChildRow,
  undelivered: number,
  opts: { ordinal?: number; redactRepo?: boolean } = {}
): OrchestrationChildDto {
  const parsed = ChildResultSchema.safeParse(row.resultJson);
  const result = opts.redactRepo ? null : parsed.success ? parsed.data : null;
  const ledger = row.workRequest?.activeWorkflows ?? [];
  const accrued = ledger.reduce((sum, w) => sum + (w.costUsdAccrued ?? 0), 0);
  const branch = opts.redactRepo
    ? null
    : (result?.branch ?? ledger.find((w) => w.assignedBranch)?.assignedBranch ?? null);
  return {
    agentKey: row.agentKey,
    branch,
    costUsd: Math.max(row.costUsd, accrued),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.endedAt ? row.endedAt.toISOString() : null,
    id: row.id,
    // The orchestrator wrote the label after it read the child's full result, so for a viewer who
    // cannot reach the repository it is replaced by one that only counts.
    label: opts.redactRepo && opts.ordinal ? `Agent ${opts.ordinal}` : row.label,
    // File paths of the repository: only to someone who can reach it.
    pathScopes: opts.redactRepo ? [] : row.pathScopes,
    prUrl: result?.prUrl ?? null,
    result,
    role: row.role,
    runId: row.runId,
    status: isOneOf(CHILD_STATUSES, row.status, 'FAILED'),
    undeliveredSteering: undelivered,
    workRequestId: row.workRequestId,
  };
}

interface OrchestrationRow {
  budgetTier: string;
  createdAt: Date;
  id: string;
  launchedById: string | null;
  repoAttachedAt: Date | null;
  repoId: string | null;
  status: string;
  teamId: string;
  title: string;
  updatedAt: Date;
}

export function summaryView(
  row: OrchestrationRow & {
    repo?: { organizationName: string | null; repoName: string | null } | null;
    team?: { name: string } | null;
  },
  counts: { childCount: number; costUsd: number; runningChildCount: number },
  opts: { redactRepo?: boolean } = {}
): OrchestrationSummaryDto {
  return {
    childCount: counts.childCount,
    costUsd: counts.costUsd,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    launchedById: row.launchedById,
    repoId: row.repoId,
    repoName:
      row.repo && !opts.redactRepo
        ? row.repo.organizationName && row.repo.repoName
          ? `${row.repo.organizationName}/${row.repo.repoName}`
          : null
        : null,
    runningChildCount: counts.runningChildCount,
    status: isOneOf(ORCHESTRATION_STATUSES, row.status, 'FAILED'),
    teamId: row.teamId,
    teamName: row.team?.name ?? null,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Db = FastifyInstance['prisma'];

const CHILD_INCLUDE = {
  workRequest: {
    select: {
      activeWorkflows: {
        select: {
          assignedBranch: true,
          costUsdAccrued: true,
          tokensInputCountedUsed: true,
          tokensInputUsed: true,
          tokensOutputUsed: true,
        },
      },
    },
  },
} as const;

/** Everything `GET /:id` returns. `canControl` is decided by the caller. */
export interface DetailRow extends OrchestrationRow {
  allowlist: string[];
  connectionIds: string[];
  deliveryDefault?: string | null;
  launchedBy: { name: string | null } | null;
  orgId?: string | null;
  repo: {
    organizationName: string | null;
    repoName: string | null;
    /** The owning team, which bills the children once the repository is attached. */
    teamId?: string | null;
    team?: { name: string; orgId?: string | null } | null;
  } | null;
  team: { name: string };
  workRequest: {
    activeWorkflows: Array<{
      costUsdAccrued: number;
      tokensInputCountedUsed?: bigint | number | null;
      tokensInputUsed?: bigint | number | null;
      tokensOutputUsed?: bigint | number | null;
    }>;
  } | null;
}

const DELIVERY_DEFAULTS = ['none', 'branch', 'draft_pr'] as const;

type Ledger = NonNullable<DetailRow['workRequest']>['activeWorkflows'];

/**
 * What the orchestration has spent against its tier's token cap, orchestrator and children
 * together. The binding cap is whichever of the input and output caps is nearer; the input side
 * counts what a run's own cap counts (`tokensInputCountedUsed`: cache reads and writes at their
 * cost-equivalent), falling back to the raw total where that is absent. Null when the tier has no
 * usable cap or the defaults cannot be read. Never throws: a readout must not fail the detail.
 */
async function tokenReadout(
  tier: string,
  ledgers: Ledger
): Promise<{
  percentUsed: number;
  tokens: { cap: number; kind: 'input' | 'output'; used: number };
} | null> {
  try {
    const cap = (await resolveWorkflowDefaults()).budgetTiers?.[tier];
    if (!cap || !(cap.inputTokens > 0) || !(cap.outputTokens > 0)) {
      return null;
    }
    const usedIn = ledgers.reduce(
      (s, w) => s + Number(w.tokensInputCountedUsed ?? w.tokensInputUsed ?? 0),
      0
    );
    const usedOut = ledgers.reduce((s, w) => s + Number(w.tokensOutputUsed ?? 0), 0);
    const binding =
      usedOut / cap.outputTokens > usedIn / cap.inputTokens
        ? { cap: cap.outputTokens, kind: 'output' as const, used: usedOut }
        : { cap: cap.inputTokens, kind: 'input' as const, used: usedIn };
    return { percentUsed: Math.round((binding.used / binding.cap) * 100), tokens: binding };
  } catch {
    return null;
  }
}

/**
 * What is left of the tightest monthly USD budget among every team and organization that BILLS
 * this orchestration: the named team and its organization, and, once a repository is attached,
 * the repository's owning team and organization (children bill that team). Month to date,
 * including runs still in flight; floors at zero. Null when none of them sets a budget, or on any
 * read failure.
 */
async function monthlyRemainingUsd(
  prisma: Db,
  billers: Array<{ orgId?: string | null; teamId: string }>
): Promise<number | null> {
  try {
    const teamIds = [...new Set(billers.map((b) => b.teamId))];
    const orgIds = new Set(billers.map((b) => b.orgId).filter((id): id is string => !!id));
    const remaining: number[] = [];
    for (const teamId of teamIds) {
      const team = await runUnscoped('the budget of a billing team', ['Team'], () =>
        prisma.team.findFirst({
          select: { monthlyBudgetUsdCents: true, orgId: true },
          where: { id: teamId },
        })
      );
      if (team?.orgId) {
        orgIds.add(team.orgId);
      }
      if (team?.monthlyBudgetUsdCents != null) {
        const spend = await teamMonthSpend(prisma, teamId);
        remaining.push(team.monthlyBudgetUsdCents / 100 - spend.totalUsd);
      }
    }
    for (const orgId of orgIds) {
      const org = await prisma.organization.findFirst({
        select: { monthlyBudgetUsdCents: true },
        where: { id: orgId },
      });
      if (org?.monthlyBudgetUsdCents != null) {
        const spend = await orgMonthSpend(prisma, orgId);
        remaining.push(org.monthlyBudgetUsdCents / 100 - spend.totalUsd);
      }
    }
    return remaining.length === 0 ? null : Math.max(0, Math.min(...remaining));
  } catch {
    return null;
  }
}

export async function buildDetail(
  prisma: Db,
  row: DetailRow,
  ctx: { canControl: boolean; canEmergencyStop?: boolean; viewer: Viewer }
): Promise<OrchestrationDetailDto> {
  const { canControl, canEmergencyStop, viewer } = ctx;
  const sees = await canSeeRepoData(prisma, viewer, row);
  const children = await prisma.orchestrationChild.findMany({
    include: CHILD_INCLUDE,
    orderBy: { createdAt: 'asc' },
    where: { orchestrationId: row.id },
  });
  const runIds = children.map((c) => c.runId).filter((id): id is string => !!id);
  const steering = runIds.length
    ? await prisma.runSteeringMessage.groupBy({
        _count: { _all: true },
        by: ['runId'],
        where: { deliveredAt: null, runId: { in: runIds } },
      })
    : [];
  const undelivered = new Map(steering.map((g) => [g.runId, g._count._all]));
  const now = new Date();
  const approvals = await prisma.orchestrationApproval.findMany({
    orderBy: { createdAt: 'asc' },
    where: { expiresAt: { gt: now }, orchestrationId: row.id, status: 'PENDING' },
  });
  const connectionIds = [
    ...new Set([...row.connectionIds, ...approvals.map((a) => a.connectionId)]),
  ];
  const connections = connectionIds.length
    ? await prisma.connection.findMany({
        select: { id: true, name: true },
        where: { id: { in: connectionIds }, teamId: row.teamId },
      })
    : [];
  const names = new Map(connections.map((c) => [c.id, c.name]));
  const attachMsg = row.repoId
    ? null
    : await prisma.orchestrationMessage.findFirst({
        orderBy: { createdAt: 'desc' },
        where: { kind: 'ATTACH_REQUEST', orchestrationId: row.id },
      });
  const attachPayload = (attachMsg?.payload ?? {}) as Record<string, unknown>;
  const deliveryDefault = (DELIVERY_DEFAULTS as readonly string[]).includes(
    row.deliveryDefault ?? ''
  )
    ? (row.deliveryDefault as (typeof DELIVERY_DEFAULTS)[number])
    : null;
  let pendingAttach: OrchestrationDetailDto['pendingAttach'] = null;
  if (attachMsg && isAttachRequestPending(attachPayload)) {
    const candidateRepoId =
      typeof attachPayload.candidateRepoId === 'string'
        ? attachPayload.candidateRepoId
        : typeof attachPayload.candidate === 'string'
          ? attachPayload.candidate
          : null;
    // The candidate's name and billing team only to someone who can reach that repository.
    const candidate = candidateRepoId
      ? await prisma.connection.findFirst({
          select: { organizationName: true, repoName: true, team: { select: { name: true } } },
          where: {
            id: candidateRepoId,
            ...(viewer.admin ? {} : repoMemberWhere({ userId: viewer.sub })),
          },
        })
      : null;
    pendingAttach = {
      billingTeamName: candidate?.team.name ?? null,
      candidateRepoId,
      candidateRepoName:
        candidate?.organizationName && candidate.repoName
          ? `${candidate.organizationName}/${candidate.repoName}`
          : null,
      deliveryDefault,
      messageId: attachMsg.id,
      reason: typeof attachPayload.reason === 'string' ? attachPayload.reason : attachMsg.body,
    };
  }

  const childViews = children.map((c, index) =>
    childView(c as unknown as ChildRow, c.runId ? (undelivered.get(c.runId) ?? 0) : 0, {
      ordinal: index + 1,
      redactRepo: !sees,
    })
  );
  const childrenUsd = childViews.reduce((s, c) => s + c.costUsd, 0);
  const ledger = row.workRequest?.activeWorkflows ?? [];
  const orchestratorUsd = ledger.reduce((s, w) => s + w.costUsdAccrued, 0);
  const readout = await tokenReadout(row.budgetTier, [
    ...ledger,
    ...children.flatMap((c) => c.workRequest?.activeWorkflows ?? []),
  ]);
  return {
    ...summaryView(
      row,
      {
        childCount: childViews.length,
        costUsd: childrenUsd + orchestratorUsd,
        runningChildCount: childViews.filter(
          (c) => c.status === 'STARTING' || c.status === 'RUNNING'
        ).length,
      },
      { redactRepo: !sees }
    ),
    allowlist: row.allowlist,
    billing: {
      // Children spawned after an attach bill the repository's owning team; before it, the named team.
      // The owning team of the attached repository is repository-derived: withheld from a viewer
      // who cannot reach it.
      childrenTeamName: sees ? (row.repo?.team?.name ?? row.team.name) : null,
      orchestratorTeamName: row.team.name,
    },
    budget: {
      monthlyRemainingUsd: await monthlyRemainingUsd(prisma, [
        { orgId: row.orgId, teamId: row.teamId },
        ...(row.repo?.teamId ? [{ orgId: row.repo.team?.orgId, teamId: row.repo.teamId }] : []),
      ]),
      percentUsed: readout?.percentUsed ?? null,
      // Deprecated: it once carried the tier's USD estimate. Kept for older clients, always null.
      remainingUsd: null,
      tier: row.budgetTier,
      tokens: readout?.tokens ?? null,
    },
    budgetTier: row.budgetTier,
    canControl,
    canEmergencyStop: canEmergencyStop === true,
    children: childViews,
    connections: row.connectionIds.map((id) => ({ id, name: names.get(id) ?? null })),
    cost: { childrenUsd, orchestratorUsd, totalUsd: childrenUsd + orchestratorUsd },
    deliveryDefault,
    launchedByName: row.launchedBy?.name ?? null,
    pendingApprovals: approvals.map((a) => approvalView(a, names)),
    pendingAttach,
    repoAttachedAt: row.repoAttachedAt ? row.repoAttachedAt.toISOString() : null,
    teamName: row.team.name,
  };
}

// ── Child width and scope checks (spec 4.1 steps 3-4) ───────────────────────

export interface SpawnCounts {
  children: Array<{ pathScopes: string[]; role: string; status: string }>;
}

/**
 * The width limits and writer-scope reservations a spawn must satisfy, over the orchestration's
 * current children. Run once outside and once inside the ledger transaction (under the
 * orchestration's row lock) so two concurrent spawns cannot both pass. Only writers that are
 * STARTING or RUNNING reserve scopes; a finished writer no longer blocks a later one.
 */
export function checkSpawnBounds(
  children: SpawnCounts['children'],
  pins: OrchestrationPins,
  spawn: { role: 'reader' | 'writer'; scopes: ParsedScope[]; sharedOwner: boolean }
): { code: 'CHILD_LIMIT' | 'SCOPE_OVERLAP'; message: string } | null {
  if (children.length >= pins.maxChildren) {
    return {
      code: 'CHILD_LIMIT',
      message: `This orchestration has started its ${pins.maxChildren} children`,
    };
  }
  const live = children.filter((c) =>
    (CHILD_LIVE_STATUSES as readonly string[]).includes(c.status)
  );
  if (live.length >= pins.maxConcurrentChildren) {
    return {
      code: 'CHILD_LIMIT',
      message: `${pins.maxConcurrentChildren} children are already running; wait for one to finish`,
    };
  }
  if (spawn.role === 'writer') {
    const writers = children.filter((c) => c.role === 'WRITER');
    if (writers.length >= pins.maxWriterChildren) {
      return {
        code: 'CHILD_LIMIT',
        message: `This orchestration has started its ${pins.maxWriterChildren} writer children`,
      };
    }
  }
  return null;
}

/** Parse stored scope strings back into `ParsedScope`s; an unparsable one is kept as a whole-repo wildcard-like overlap by the caller. */
export function parseStoredScopes(scopes: string[]): {
  parsed: ParsedScope[];
  unparsable: boolean;
} {
  const parsed: ParsedScope[] = [];
  let unparsable = false;
  for (const raw of scopes) {
    const p = parsePathScope(raw);
    if (p.ok) {
      parsed.push(p.scope);
    } else {
      unparsable = true;
    }
  }
  return { parsed, unparsable };
}

export type { ChildStatus, Prisma };
