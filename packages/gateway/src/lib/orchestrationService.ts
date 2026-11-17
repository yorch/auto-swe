import type { Prisma } from '@auto-swe/shared';
import { resolveSettings } from '@auto-swe/shared/config';
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

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso ?? '');
    return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
  } catch {
    return null;
  }
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

export function childView(row: ChildRow, undelivered: number): OrchestrationChildDto {
  const parsed = ChildResultSchema.safeParse(row.resultJson);
  const result = parsed.success ? parsed.data : null;
  const ledger = row.workRequest?.activeWorkflows ?? [];
  const accrued = ledger.reduce((sum, w) => sum + (w.costUsdAccrued ?? 0), 0);
  const branch = result?.branch ?? ledger.find((w) => w.assignedBranch)?.assignedBranch ?? null;
  return {
    agentKey: row.agentKey,
    branch,
    costUsd: Math.max(row.costUsd, accrued),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.endedAt ? row.endedAt.toISOString() : null,
    id: row.id,
    label: row.label,
    pathScopes: row.pathScopes,
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
  },
  counts: { childCount: number; costUsd: number; runningChildCount: number }
): OrchestrationSummaryDto {
  return {
    childCount: counts.childCount,
    costUsd: counts.costUsd,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    launchedById: row.launchedById,
    repoId: row.repoId,
    repoName: row.repo
      ? row.repo.organizationName && row.repo.repoName
        ? `${row.repo.organizationName}/${row.repo.repoName}`
        : null
      : null,
    runningChildCount: counts.runningChildCount,
    status: isOneOf(ORCHESTRATION_STATUSES, row.status, 'FAILED'),
    teamId: row.teamId,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Db = FastifyInstance['prisma'];

const CHILD_INCLUDE = {
  workRequest: {
    select: { activeWorkflows: { select: { assignedBranch: true, costUsdAccrued: true } } },
  },
} as const;

/** Everything `GET /:id` returns. `canControl` is decided by the caller. */
export async function buildDetail(
  prisma: Db,
  row: OrchestrationRow & {
    allowlist: string[];
    connectionIds: string[];
    launchedBy: { name: string | null } | null;
    repo: { organizationName: string | null; repoName: string | null } | null;
    team: { name: string };
    workRequest: { activeWorkflows: Array<{ costUsdAccrued: number }> } | null;
  },
  canControl: boolean
): Promise<OrchestrationDetailDto> {
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
  const pendingAttach =
    attachMsg && isAttachRequestPending(attachPayload)
      ? {
          candidateRepoId:
            typeof attachPayload.candidateRepoId === 'string'
              ? attachPayload.candidateRepoId
              : typeof attachPayload.candidate === 'string'
                ? attachPayload.candidate
                : null,
          messageId: attachMsg.id,
          reason: typeof attachPayload.reason === 'string' ? attachPayload.reason : attachMsg.body,
        }
      : null;

  const childViews = children.map((c) =>
    childView(c as unknown as ChildRow, c.runId ? (undelivered.get(c.runId) ?? 0) : 0)
  );
  const childrenUsd = childViews.reduce((s, c) => s + c.costUsd, 0);
  const orchestratorUsd =
    row.workRequest?.activeWorkflows.reduce((s, w) => s + w.costUsdAccrued, 0) ?? 0;
  return {
    ...summaryView(row, {
      childCount: childViews.length,
      costUsd: childrenUsd + orchestratorUsd,
      runningChildCount: childViews.filter((c) => c.status === 'STARTING' || c.status === 'RUNNING')
        .length,
    }),
    allowlist: row.allowlist,
    budgetTier: row.budgetTier,
    canControl,
    children: childViews,
    connections: row.connectionIds.map((id) => ({ id, name: names.get(id) ?? null })),
    cost: { childrenUsd, orchestratorUsd, totalUsd: childrenUsd + orchestratorUsd },
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
