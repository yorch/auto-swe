import { createHash, randomUUID } from 'node:crypto';
import { type Prisma, Role } from '@auto-swe/shared';
import { resolveSetting, resolveSettings } from '@auto-swe/shared/config';
import {
  AGENT_RUN_MAX_PROMPT_CHARS,
  isLaunchableAgentKey,
  NON_LAUNCHABLE_AGENT_KEYS,
} from '@auto-swe/shared/lib/agentRun';
import {
  firstOverlap,
  isAttachRequestPending,
  ORCHESTRATION_SIGNALS,
  ORCHESTRATION_STATUSES,
  OrchestrationLaunchSchema,
  orchestrationWorkflowId,
  type ParsedScope,
  SpawnIntentSchema,
  validatePathScopes,
} from '@auto-swe/shared/lib/orchestration';
import {
  ApprovalDecisionBodySchema,
  AttachRepoBodySchema,
  OrchestrationBodySchema,
} from '@auto-swe/shared/lib/orchestrationApi';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '@auto-swe/shared/types/api';
import type { BudgetTier } from '@auto-swe/shared/types/workflow';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  agentRunWorkflowId,
  agentScopeBranches,
  authorizeAgentRunRepo,
  createAgentRunLauncher,
  splitRef,
} from '../lib/agentRunLaunch.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { IdempotencyHeaderSchema, uuidFromIdempotencyKey } from '../lib/idempotency.js';
import {
  assertMcpWriteAllowed,
  mcpWriteAuditHook,
  mcpWriteBegin,
  runCapGuard,
  sendRunCapRefusal,
} from '../lib/mcpWriteGuard.js';
import { authorizeTeamLaunch, checkPushPermission } from '../lib/orchestrationAccess.js';
import {
  resolveDefaultAllowlist,
  resolveDefaults,
  writeCapableRefs,
} from '../lib/orchestrationDefaults.js';
import type { OrchestrationWorkflowInput } from '../lib/orchestrationInput.js';
import {
  buildDetail,
  CHILD_LIVE_STATUSES,
  canSeeRepoData,
  checkSpawnBounds,
  childView,
  decodeCursor,
  encodeCursor,
  isHiddenMessage,
  launchedByViewer,
  launcherSeesRepo,
  messageView,
  ORCHESTRATION_LIVE_STATUSES,
  parseStoredScopes,
  reachableRepoIds,
  redactMessage,
  refusal,
  resolvePins,
  storedPins,
  summaryView,
  type Viewer,
} from '../lib/orchestrationService.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import {
  idempotencyCallerScope,
  sendServiceLaunchRefusal,
  servicePrincipalLaunchGuard,
} from '../lib/servicePrincipals.js';
import {
  isTemporalUnavailable,
  isTerminalSignalError,
  replyIfTemporalUnavailable,
  sendTemporalUnavailable,
} from '../lib/temporalErrors.js';
import { type LaunchGuard, launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { requireAuth, requireCaller, requireUser } from '../plugins/auth.js';

/**
 * `/api/v1/orchestrations`: a durable conversation with an `orchestrator` agent and the child
 * agent runs it starts (docs/specs/2026-11-17-orchestrated-agent-runs.md).
 *
 * Who may do what: the named team's members, the launcher and ADMIN can read. Only the launcher
 * sends messages, attaches a repository, approves an MCP write, cancels or ends. The worker calls
 * the child, message and cancel routes with an orchestration token (`@auto-swe/shared/lib/orchestrationTokenKey`),
 * which acts as the launcher and is admitted on those routes alone. This file never lets an agent
 * choose its own authority: attach and approvals take a person's session or PAT, and
 * `assistantPolicy.ts` refuses them to the in-app assistant.
 */

const IdParams = z.object({ id: z.uuid() });
const ChildParams = z.object({ childId: z.uuid(), id: z.uuid() });
const ApprovalParams = z.object({ approvalId: z.uuid(), id: z.uuid() });

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(ORCHESTRATION_STATUSES).optional(),
  teamId: z.uuid().optional(),
});
const MessagesQuery = z.object({
  after: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const SpawnBody = z.object({
  intent: z.unknown(),
  turnKey: z.string().min(1).max(200),
});

/** Delivery modes from least to most permissive. */
const DELIVER_RANK = ['none', 'branch', 'draft_pr'];
const STREAM_POLL_MS = 1500;
const STREAM_HEARTBEAT_MS = 15_000;
const STREAM_RETRY_MS = 3000;
const STREAM_MAX_MS = 16 * 60 * 1000;
// How often an open stream asks again whether its viewer may still see the orchestration.
const STREAM_ACCESS_RECHECK_MS = 60_000;
const MAX_STREAMS_PER_USER = 4;
const openStreams = new Map<string, number>();

/**
 * Every refusal of the spawn route in one envelope the worker can parse: `{ code, message,
 * error: { code, message } }` (plus `error.details` when the refusal had any). The launch
 * pipeline answers in the gateway's `{ error }` shape for ordinary errors and in this one for
 * orchestration refusals; this makes the code and a readable message present either way.
 */
function normalizeRefusalBody(statusCode: number, payload: unknown): unknown {
  if (statusCode < 400 || typeof payload !== 'string') {
    return payload;
  }
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return payload;
  }
  const b = body as Record<string, unknown>;
  const e = b.error && typeof b.error === 'object' ? (b.error as Record<string, unknown>) : null;
  const pick = (...vals: unknown[]) => vals.find((v): v is string => typeof v === 'string' && !!v);
  const code = pick(e?.code, b.code) ?? `HTTP_${statusCode}`;
  const message =
    pick(e?.message, b.message, typeof b.error === 'string' ? b.error : undefined) ??
    `The agent could not be started (${code})`;
  return JSON.stringify({
    code,
    error: { ...(e ?? {}), code, message },
    message,
  });
}

/**
 * Whether a stored writer holds a shared file (lock file, root package.json, barrel). Judged one
 * scope at a time: a scope names one exactly when it is refused without the owner flag, and a
 * stored scope that no longer parses is treated as one (fail closed). Never over the
 * concatenation of several writers' scopes, which hits the 20-scope cap and refuses on size.
 */
function holdsSharedFile(writer: { pathScopes: string[] }): boolean {
  return writer.pathScopes.some((scope) => !validatePathScopes([scope]).ok);
}

/** Thrown inside the attach-request transaction to refuse the resolution and roll it back. */
class ResolveRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Thrown inside the ledger transaction to refuse a spawn and roll the launch back. */
class SpawnRefusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

type OrchestrationAction =
  | 'launch'
  | 'spawn'
  | 'refusal'
  | 'steer'
  | 'attach'
  | 'approval'
  | 'cancel';

export const orchestrationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const launchAgentRun = createAgentRunLauncher(fastify);

  const prisma = fastify.prisma;

  async function audit(
    request: FastifyRequest,
    entityId: string,
    action: OrchestrationAction,
    after: Record<string, unknown>
  ): Promise<void> {
    try {
      await writeAuditLog(fastify, {
        action: action === 'launch' ? 'CREATE' : 'UPDATE',
        actor: request.user ?? null,
        after: {
          action,
          ...after,
          ...(request.principal ? { serviceId: request.principal.servicePrincipalId } : {}),
          // The call arrived through the MCP bridge, not the dashboard or the CLI.
          ...(request.mcpBridge ? { mcp: { clientId: request.mcpBridge.clientId } } : {}),
        },
        entityId,
        entityType: 'Orchestration',
      });
    } catch (err) {
      request.log.error({ action, err }, 'orchestration audit entry could not be written');
    }
  }

  /**
   * Keep the orchestrator's own ledger row (`ActiveWorkflow`, keyed by the orchestration's workflow
   * id and work request) in step with its status, so it counts toward a launcher's in-flight cap
   * only while the orchestration is running. `close` finishes a row that is not terminal yet;
   * `reopen` revives a row an idle or ended orchestration had closed as COMPLETED. The worker keeps
   * the same row in step when it records WAITING or COMPLETED.
   */
  async function closeLedger(
    request: FastifyRequest,
    row: { id: string; workRequestId: string | null },
    to: 'CANCELLED' | 'COMPLETED'
  ): Promise<void> {
    if (!row.workRequestId) {
      return;
    }
    try {
      await prisma.activeWorkflow.updateMany({
        data: { currentStatus: to },
        where: {
          currentStatus: { notIn: [...ACTIVE_WORKFLOW_TERMINAL_STATUSES] },
          temporalWorkflowId: orchestrationWorkflowId(row.id),
          workRequestId: row.workRequestId,
        },
      });
    } catch (err) {
      request.log.error({ err, orchestrationId: row.id }, 'orchestrator ledger row not closed');
    }
  }

  /**
   * Wake the orchestration's ledger row after a signal (attach and decline). Conditional on the
   * orchestration's CURRENT status, read under its row lock in the same transaction: a cancel that
   * landed since the caller's read leaves the row closed, so a cancelled orchestration never holds
   * a concurrency slot.
   */
  async function reopenLedger(
    request: FastifyRequest,
    row: { id: string; teamId: string; workRequestId: string | null }
  ): Promise<void> {
    if (!row.workRequestId) {
      return;
    }
    const workRequestId = row.workRequestId;
    try {
      await prisma.$transaction(async (tx) => {
        // CLAUDE.md §7 exception: the orchestration's row lock, so a concurrent cancel is ordered.
        await tx.$queryRaw`SELECT id FROM orchestrations WHERE id = ${row.id}::uuid FOR UPDATE`;
        const current = await tx.orchestration.findFirst({
          select: { status: true },
          where: { id: row.id, teamId: row.teamId },
        });
        if (!current || !ORCHESTRATION_LIVE_STATUSES.includes(current.status as never)) {
          return;
        }
        await tx.activeWorkflow.updateMany({
          data: { currentStatus: 'IMPLEMENTING' },
          where: {
            currentStatus: 'COMPLETED',
            temporalWorkflowId: orchestrationWorkflowId(row.id),
            workRequestId,
          },
        });
      });
    } catch (err) {
      request.log.error({ err, orchestrationId: row.id }, 'orchestrator ledger row not reopened');
    }
  }

  type Wake =
    | { kind: 'ok'; reopened: boolean; revived: boolean }
    | { kind: 'ended' }
    | { kind: 'capped' }
    | { kind: 'refused'; refusal: string };

  /**
   * Prepare a message that will start (or restart) the orchestrator's workflow, in ONE transaction
   * under the orchestration's row lock: re-read its status, revive a COMPLETED one for a direct
   * caller, and reopen the parked ledger row (COMPLETED to IMPLEMENTING). For a bridged caller the
   * launcher's `mcp.maxConcurrentRuns` cap is applied first, under the per-user advisory lock the
   * launch path takes (`runCapGuard`): over the cap nothing is written. For a service principal
   * the launch guard (`servicePrincipalLaunchGuard`: still enabled, repository still on its
   * allowlist and its team's, in-flight and daily limits) runs under the principal's row lock
   * before the ledger row is reopened or the orchestration revived: a refusal writes nothing. The
   * signal is sent only after this commits, and `undoWake` puts back what it changed if the
   * signal fails.
   */
  async function prepareWake(
    row: { id: string; teamId: string; workRequestId: string | null },
    opts: {
      cap: { cap: number; userId: string } | null;
      guard?: LaunchGuard | null;
      revive: boolean;
    }
  ): Promise<Wake> {
    return prisma.$transaction(async (tx) => {
      // CLAUDE.md §7 exception: the orchestration's row lock, so a concurrent cancel is ordered.
      await tx.$queryRaw`SELECT id FROM orchestrations WHERE id = ${row.id}::uuid FOR UPDATE`;
      const current = await tx.orchestration.findFirst({
        select: { status: true },
        where: { id: row.id, teamId: row.teamId },
      });
      const live = !!current && ORCHESTRATION_LIVE_STATUSES.includes(current.status as never);
      const reviving = opts.revive && current?.status === 'COMPLETED';
      if (!live && !reviving) {
        return { kind: 'ended' } as const;
      }
      let reopened = false;
      const parked = row.workRequestId
        ? {
            currentStatus: 'COMPLETED',
            temporalWorkflowId: orchestrationWorkflowId(row.id),
            workRequestId: row.workRequestId,
          }
        : null;
      if (
        opts.guard &&
        (reviving || (parked && (await tx.activeWorkflow.count({ where: parked })) > 0))
      ) {
        // A new execution is about to start: a principal's launch limits and grants apply again.
        const refusal = await opts.guard(tx);
        if (refusal) {
          return { kind: 'refused', refusal } as const;
        }
      }
      if (row.workRequestId && parked) {
        if (opts.cap && (await tx.activeWorkflow.count({ where: parked })) > 0) {
          // A new execution is about to start: it counts as in flight, so the cap applies.
          if (await runCapGuard(opts.cap.userId, opts.cap.cap)(tx)) {
            return { kind: 'capped' } as const;
          }
        }
        const { count } = await tx.activeWorkflow.updateMany({
          data: { currentStatus: 'IMPLEMENTING' },
          where: parked,
        });
        reopened = count > 0;
      }
      let revived = false;
      if (reviving) {
        const { count } = await tx.orchestration.updateMany({
          data: { endedAt: null, status: 'ACTIVE' },
          where: { id: row.id, status: 'COMPLETED', teamId: row.teamId },
        });
        revived = count === 1;
      }
      return { kind: 'ok', reopened, revived } as const;
    });
  }

  /** Put back what `prepareWake` changed, each step a compare-and-set so a cancel is never undone. */
  async function undoWake(
    request: FastifyRequest,
    row: { id: string; teamId: string; workRequestId: string | null },
    wake: { reopened: boolean; revived: boolean }
  ): Promise<void> {
    try {
      if (wake.revived) {
        await prisma.orchestration.updateMany({
          data: { endedAt: new Date(), status: 'COMPLETED' },
          where: { id: row.id, status: 'ACTIVE', teamId: row.teamId },
        });
      }
      if (wake.reopened && row.workRequestId) {
        await prisma.activeWorkflow.updateMany({
          data: { currentStatus: 'COMPLETED' },
          where: {
            currentStatus: 'IMPLEMENTING',
            temporalWorkflowId: orchestrationWorkflowId(row.id),
            workRequestId: row.workRequestId,
          },
        });
      }
    } catch (err) {
      request.log.error({ err, orchestrationId: row.id }, 'orchestration wake not undone');
    }
  }

  /**
   * Sends the refusal and answers true. (Not the reply itself: an async function that returns a
   * Fastify reply resolves it, not hands it back.) A bridged message steers an orchestration only when its delivery default is no broader than
   * the highest mode `mcp.agentRunAllowedDeliverModes` allows now (order none, branch, draft_pr; a
   * null default is none). Reads are not affected.
   */
  async function mcpDeliveryRefusal(
    request: FastifyRequest,
    reply: FastifyReply,
    deliveryDefault: string | null
  ): Promise<boolean> {
    if (!request.mcpBridge) {
      return false;
    }
    const modes = (await resolveSettings(['mcp.agentRunAllowedDeliverModes']))[
      'mcp.agentRunAllowedDeliverModes'
    ];
    const highest = Math.max(-1, ...modes.map((m) => DELIVER_RANK.indexOf(m)));
    if (Math.max(0, DELIVER_RANK.indexOf(deliveryDefault ?? 'none')) > highest) {
      sendError(
        reply,
        403,
        'MCP_DELIVER_MODE_NOT_ALLOWED',
        "This orchestration's delivery default is not allowed through MCP"
      );
      return true;
    }
    return false;
  }

  /** Whether the kill switch is on; 503 when it cannot be read (fail closed). */
  async function switchOn(request: FastifyRequest, reply: FastifyReply): Promise<boolean | 'sent'> {
    try {
      return await resolveSetting('orchestration.enabled');
    } catch (err) {
      request.log.error({ err }, 'orchestration.enabled could not be read');
      sendError(reply, 503, 'ORCHESTRATION_UNAVAILABLE', 'Orchestrations are unavailable');
      return 'sent';
    }
  }

  const DETAIL_SELECT = {
    allowlist: true,
    budgetTier: true,
    connectionIds: true,
    createdAt: true,
    deliveryDefault: true,
    id: true,
    launchedBy: { select: { name: true } },
    launchedById: true,
    orgId: true,
    repo: {
      select: {
        organizationName: true,
        repoName: true,
        team: { select: { name: true, orgId: true } },
        teamId: true,
      },
    },
    repoAttachedAt: true,
    repoId: true,
    serviceId: true,
    status: true,
    team: { select: { name: true } },
    teamId: true,
    title: true,
    updatedAt: true,
    workRequest: {
      select: {
        activeWorkflows: {
          select: {
            costUsdAccrued: true,
            tokensInputCountedUsed: true,
            tokensInputUsed: true,
            tokensOutputUsed: true,
          },
        },
        payload: true,
      },
    },
    workRequestId: true,
  } as const;

  /**
   * The orchestration if the caller may see it, else null. A person sees what they launched, what
   * their team's membership reaches (ADMIN: everything); a service principal sees only the
   * orchestrations it launched, matched on its own id and on nothing else.
   */
  async function visible(request: FastifyRequest, id: string) {
    const caller = requireCaller(request);
    if (caller.kind === 'service') {
      return runUnscoped(
        'a service principal sees only the orchestrations it launched, matched by its own serviceId',
        ['Orchestration'],
        () =>
          prisma.orchestration.findFirst({
            select: DETAIL_SELECT,
            where: { id, serviceId: caller.principal.servicePrincipalId },
          })
      );
    }
    const user = caller.user;
    return asPlatformAdmin(user, 'an admin may read any orchestration', ['Orchestration'], () =>
      prisma.orchestration.findFirst({
        select: DETAIL_SELECT,
        where: {
          id,
          ...(user.role === Role.ADMIN
            ? {}
            : {
                OR: [
                  { launchedById: user.sub },
                  { team: { memberships: { some: { userId: user.sub } } } },
                ],
              }),
        },
      })
    );
  }

  function viewerOf(request: FastifyRequest): Viewer {
    const caller = requireCaller(request);
    return caller.kind === 'service'
      ? { admin: false, serviceId: caller.principal.servicePrincipalId, sub: '' }
      : { admin: caller.user.role === Role.ADMIN, sub: caller.user.sub };
  }

  /**
   * The orchestration if the caller is its launcher and a person (a session, PAT or token): for
   * the acts that stay human-only (attach, decline, approvals). A service principal is refused
   * here whatever it launched.
   */
  async function launcherOwned(request: FastifyRequest, reply: FastifyReply, id: string) {
    const row = await visible(request, id);
    if (!row) {
      sendError(reply, 404, 'NOT_FOUND', 'Orchestration not found');
      return null;
    }
    if (request.principal || !request.user || row.launchedById !== request.user.sub) {
      sendError(reply, 403, 'NOT_LAUNCHER', 'Only the person who launched this can do that');
      return null;
    }
    return row;
  }

  /**
   * The orchestration if the caller is its launcher: the person who launched it, or the service
   * principal whose id it carries as `serviceId`. For the acts a launching principal may take
   * (message, cancel, end). Anyone else is refused as `launcherOwned` refuses.
   *
   * With `emergencyStop` (cancel and end only) an ADMIN may also act on an orchestration that has
   * no human launcher (`serviceId` set, `launchedById` null): an operator's stop for a runaway
   * principal-launched orchestration. A person's orchestration stays its launcher's alone.
   */
  async function controlOwned(
    request: FastifyRequest,
    reply: FastifyReply,
    id: string,
    opts: { emergencyStop?: boolean } = {}
  ) {
    const row = await visible(request, id);
    if (!row) {
      sendError(reply, 404, 'NOT_FOUND', 'Orchestration not found');
      return null;
    }
    const caller = requireCaller(request);
    const owns =
      caller.kind === 'service'
        ? row.serviceId === caller.principal.servicePrincipalId
        : row.launchedById === caller.user.sub || (opts.emergencyStop && isAdminStop(request, row));
    if (!owns) {
      sendError(reply, 403, 'NOT_LAUNCHER', 'Only the launcher of this can do that');
      return null;
    }
    return row;
  }

  /** Whether this is an ADMIN's emergency stop of an orchestration no person launched. */
  function isAdminStop(
    request: FastifyRequest,
    row: { launchedById: string | null; serviceId: string | null }
  ): boolean {
    const caller = requireCaller(request);
    return (
      caller.kind === 'user' &&
      caller.user.role === Role.ADMIN &&
      row.launchedById === null &&
      row.serviceId !== null
    );
  }

  /** The audit fields that name an ADMIN's emergency stop: the actor is the ADMIN, the target the principal. */
  function stopContext(
    request: FastifyRequest,
    row: { launchedById: string | null; serviceId: string | null }
  ): Record<string, unknown> {
    const caller = requireCaller(request);
    return caller.kind === 'user' &&
      row.launchedById !== caller.user.sub &&
      isAdminStop(request, row)
      ? { adminStop: true, targetServiceId: row.serviceId }
      : {};
  }

  async function workflowInput(row: {
    id: string;
    launchedById: string | null;
    orgId: string | null;
    serviceId: string | null;
    teamId: string;
    workRequest: { payload: unknown } | null;
  }): Promise<OrchestrationWorkflowInput> {
    const pinned = await storedPins(row.workRequest, {
      orgId: row.orgId ?? undefined,
      teamId: row.teamId,
    });
    return {
      orchestrationId: row.id,
      pinned,
      serviceId: row.serviceId,
      teamId: row.teamId,
      userId: row.launchedById,
    };
  }

  /** Signal a running orchestration; a closed one is not an error (nothing is waiting). */
  async function signalIfRunning(
    request: FastifyRequest,
    id: string,
    name: string,
    payload: unknown
  ): Promise<void> {
    try {
      await fastify.temporal.signalWorkflow(orchestrationWorkflowId(id), name, [payload]);
    } catch (err) {
      if (!isTerminalSignalError(err)) {
        throw err;
      }
      request.log.info({ id, name }, 'orchestration signal skipped: workflow is not running');
    }
  }

  /** The child an earlier attempt launched under this deterministic workflow id, as the spawn body. */
  async function findChildByWorkflow(
    orchestrationId: string,
    workflowId: string
  ): Promise<{ data: { childId: string; workflowId: string; workRequestId: string } } | null> {
    const wf = await prisma.activeWorkflow.findUnique({
      select: { workRequestId: true },
      where: { temporalWorkflowId: workflowId },
    });
    const child = wf?.workRequestId
      ? await prisma.orchestrationChild.findFirst({
          select: { id: true },
          where: { orchestrationId, workRequestId: wf.workRequestId },
        })
      : null;
    return child && wf?.workRequestId
      ? { data: { childId: child.id, workflowId, workRequestId: wf.workRequestId } }
      : null;
  }

  async function cancelRun(workflowId: string): Promise<void> {
    try {
      await fastify.temporal.cancelWorkflow(workflowId);
    } catch (err) {
      if (!isTerminalSignalError(err)) {
        throw err;
      }
    }
  }

  /**
   * Cancel every child of the orchestration that has not finished, by its workflow. Returns the
   * ids it tried and how many cancels failed. Run more than once around a status change: a spawn
   * that was between its ledger write and its workflow start is not visible to the first sweep as
   * a workflow, and the spawn's own post-start re-check covers it.
   */
  async function cancelLiveChildren(
    request: FastifyRequest,
    orchestrationId: string
  ): Promise<{ failed: number; failedIds: string[]; ids: string[] }> {
    const children = await prisma.orchestrationChild.findMany({
      select: {
        id: true,
        workRequest: { select: { activeWorkflows: { select: { temporalWorkflowId: true } } } },
      },
      where: { orchestrationId, status: { in: [...CHILD_LIVE_STATUSES] } },
    });
    const failedIds = new Set<string>();
    for (const child of children) {
      for (const wf of child.workRequest.activeWorkflows) {
        try {
          await cancelRun(wf.temporalWorkflowId);
        } catch (err) {
          failedIds.add(child.id);
          request.log.error({ childId: child.id, err }, 'child cancel failed');
        }
      }
    }
    // `failed` counts children, not workflows: one child failing twice is one failure.
    return { failed: failedIds.size, failedIds: [...failedIds], ids: children.map((c) => c.id) };
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  app.post(
    '/',
    {
      // Open to service principals (repository-bound only): docs/service-principals.md.
      config: { mcpScope: 'write', serviceScopes: ['runs:agent'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      onSend: mcpWriteAuditHook,
      preValidation: mcpWriteBegin('orchestrations_launch'),
      schema: { body: OrchestrationLaunchSchema, headers: IdempotencyHeaderSchema },
    },
    async (request, reply) => {
      const caller = requireCaller(request);
      const user = caller.kind === 'user' ? caller.user : null;
      const service = caller.kind === 'service' ? caller.principal : null;
      const body = request.body;
      // First, as for an agent run: a refused MCP write never reaches a replayed answer.
      const mcpWrite = await assertMcpWriteAllowed(request, reply, {
        submit: {
          budgetTier: body.budgetTier,
          idempotencyKey: request.headers['idempotency-key'],
        },
        tool: 'orchestrations_launch',
      });
      if (mcpWrite.refused) {
        return mcpWrite.refused;
      }
      if (request.mcpBridge) {
        const modes = await resolveSettings(['mcp.agentRunAllowedDeliverModes']);
        if (!modes['mcp.agentRunAllowedDeliverModes'].includes(body.deliveryDefault)) {
          return sendError(
            reply,
            403,
            'MCP_DELIVER_MODE_NOT_ALLOWED',
            'This delivery mode is not allowed through MCP'
          );
        }
      }
      // The MCP tool has no connection set; a bridged launch cannot widen the agents' reach.
      if (request.mcpBridge && (body.connectionIds ?? []).length > 0) {
        return sendError(
          reply,
          422,
          'MCP_CONNECTIONS_NOT_ALLOWED',
          'An orchestration launched through MCP has no MCP connection set'
        );
      }
      const on = await switchOn(request, reply);
      if (on === 'sent') {
        return reply;
      }
      if (!on) {
        return sendError(reply, 403, 'ORCHESTRATION_DISABLED', 'Orchestrated runs are turned off');
      }

      // Authority: the agent-run launch decision for a repository, or team membership.
      let target: { orgId: string; teamId: string; repoId: string | null };
      if (body.repoId) {
        const repo = await authorizeAgentRunRepo(fastify, request, reply, {
          caller,
          repoId: body.repoId,
        });
        if (!repo) {
          return reply;
        }
        if (body.teamId && body.teamId !== repo.teamId) {
          return sendError(
            reply,
            400,
            'TEAM_REPO_MISMATCH',
            "teamId must be the repository's owning team; the named team is that team"
          );
        }
        target = { orgId: repo.team.orgId, repoId: repo.id, teamId: repo.teamId };
      } else {
        if (!user || !body.teamId) {
          return sendError(
            reply,
            400,
            'REPO_REQUIRED',
            'A service principal can only launch an orchestration on a repository'
          );
        }
        const team = await authorizeTeamLaunch(prisma, reply, {
          gate: request.repoAccessGate,
          log: request.log,
          teamId: body.teamId,
          user,
        });
        if (!team) {
          return reply;
        }
        target = { ...team, repoId: null };
      }

      // The agent-run kill switch and concurrency floor: 0 disables agent runs.
      const limits = await resolveSettings(
        ['workspace.agentRunMaxConcurrentGlobal', 'workspace.agentRunMaxConcurrentPerTeam'],
        { orgId: target.orgId, teamId: target.teamId }
      );
      if (
        limits['workspace.agentRunMaxConcurrentGlobal'] <= 0 ||
        limits['workspace.agentRunMaxConcurrentPerTeam'] <= 0
      ) {
        return sendError(
          reply,
          403,
          'AGENT_RUNS_DISABLED',
          'Agent runs are disabled for this team'
        );
      }

      // Idempotency comes first, before the allowlist is resolved or refused: a retry of a launch
      // that already exists answers with what it applied, even when the default has since changed.
      // Scoped to the caller; a replay answers with the orchestration it made.
      const key = request.headers['idempotency-key'];
      const connectionIds = [...new Set(body.connectionIds ?? [])];
      const requestedAllowlist = [...new Set(body.allowlist ?? [])];
      const callerScope = idempotencyCallerScope(caller);
      const id = key ? uuidFromIdempotencyKey(`orchestration-${callerScope}`, key) : randomUUID();
      // What the caller asked for, as a digest stored with the launch: the same key with a
      // different request is a mistake, not a replay (a bridged call; as for an agent run).
      const requestDigest = createHash('sha256')
        .update(
          JSON.stringify({
            allowlist: [...requestedAllowlist].sort(),
            budgetTier: body.budgetTier,
            connectionIds: [...connectionIds].sort(),
            deliveryDefault: body.deliveryDefault,
            repoId: body.repoId ?? null,
            task: body.task,
            teamId: body.teamId ?? null,
          })
        )
        .digest('hex');
      /** Answers a replay on `reply` and says so; false when there is nothing to replay. */
      const replay = async (): Promise<boolean> => {
        if (!key) {
          return false;
        }
        const existing = await prisma.orchestration.findFirst({
          select: {
            allowlist: true,
            id: true,
            launchedById: true,
            serviceId: true,
            status: true,
            workRequest: { select: { payload: true } },
          },
          // A bridged call looks across teams, so a changed team is a mismatch, not a new launch.
          where: request.mcpBridge ? { id } : { id, teamId: target.teamId },
        });
        if (!existing) {
          return false;
        }
        const same =
          existing.launchedById === (user?.sub ?? null) &&
          existing.serviceId === (service?.servicePrincipalId ?? null);
        if (!same) {
          sendError(reply, 409, 'RUN_CONFLICT', 'This idempotency key is already in use');
          return true;
        }
        const stored = (existing.workRequest?.payload ?? {}) as { requestDigest?: unknown };
        if (
          request.mcpBridge &&
          typeof stored.requestDigest === 'string' &&
          stored.requestDigest !== requestDigest
        ) {
          sendError(
            reply,
            422,
            'IDEMPOTENCY_KEY_MISMATCH',
            'This Idempotency-Key was already used for a different request. Use a new key for different orchestration inputs.'
          );
          return true;
        }
        const appliedRows = await runUnscoped(
          'an agent run resolves its agent at GLOBAL and ORGANIZATION scope only',
          ['Agent'],
          () =>
            prisma.agent.findMany({
              select: { key: true, scope: true, toolKeys: true, version: true },
              where: {
                isActive: true,
                key: { in: existing.allowlist.map((ref) => splitRef(ref).key) },
                OR: agentScopeBranches(target.orgId),
              },
            })
        );
        reply.status(200).send({
          data: {
            allowlist: existing.allowlist,
            orchestrationId: existing.id,
            status: existing.status,
            workflowId: orchestrationWorkflowId(existing.id),
            writeCapable: writeCapableRefs(existing.allowlist, appliedRows),
          },
        });
        return true;
      };
      if (await replay()) {
        return reply;
      }

      // Allowlist: launchable (the version pin stripped first), present at GLOBAL or the org's
      // scope, never the orchestrator itself; deduplicated. None named: the operator's default
      // for the org, already filtered to agents that exist; an empty result is refused.
      const allowlistDefaulted = requestedAllowlist.length === 0;
      const allowlist = allowlistDefaulted
        ? await resolveDefaultAllowlist(prisma, { orgId: target.orgId, teamId: target.teamId })
        : requestedAllowlist;
      if (allowlist.length === 0) {
        return sendError(
          reply,
          400,
          'ALLOWLIST_REQUIRED',
          'No allowlist was given and no default agents are available to this team. Pass an allowlist of agent keys.'
        );
      }
      const nonLaunchable = new Set([...NON_LAUNCHABLE_AGENT_KEYS].map((k) => k.toLowerCase()));
      const keys = new Set<string>();
      for (const ref of allowlist) {
        const { key } = splitRef(ref);
        if (!isLaunchableAgentKey(key) || nonLaunchable.has(key.trim().toLowerCase())) {
          return sendError(
            reply,
            400,
            'AGENT_NOT_LAUNCHABLE',
            `Agent '${key}' backs a platform mechanism and cannot be spawned`
          );
        }
        keys.add(key);
      }
      const agents = await runUnscoped(
        'an agent run resolves its agent at GLOBAL and ORGANIZATION scope only',
        ['Agent'],
        () =>
          prisma.agent.findMany({
            select: { key: true, scope: true, toolKeys: true, version: true },
            where: { isActive: true, key: { in: [...keys] }, OR: agentScopeBranches(target.orgId) },
          })
      );
      for (const ref of allowlist) {
        const { key, version } = splitRef(ref);
        const rows = agents.filter((a) => a.key === key);
        const found =
          version === undefined
            ? rows.length > 0
            : rows.some((a) => a.scope === 'GLOBAL' && a.version === version);
        if (!found) {
          return sendError(reply, 404, 'AGENT_NOT_FOUND', `No active agent '${ref}' to allow`);
        }
        if (version !== undefined && rows.some((a) => a.scope === 'ORGANIZATION')) {
          return sendError(
            reply,
            400,
            'AGENT_PIN_SHADOWED',
            `'${key}' has an organization override, which a version pin cannot select`
          );
        }
      }

      // Which of the applied agents can change files, as their effective (org-resolved) definition.
      const writeCapable = writeCapableRefs(allowlist, agents);

      // The MCP set: team-owned only.
      if (connectionIds.length > 0) {
        const owned = await prisma.connection.findMany({
          select: { id: true },
          where: {
            id: { in: connectionIds },
            isActive: true,
            teamId: target.teamId,
            type: 'mcp',
          },
        });
        if (owned.length !== connectionIds.length) {
          return sendError(
            reply,
            400,
            'CONNECTION_NOT_OWNED',
            'Every MCP connection must be an active connection owned by the named team'
          );
        }
      }

      const pinned = await resolvePins({ orgId: target.orgId, teamId: target.teamId });
      const workRequestId = randomUUID();
      const firstMessageId = randomUUID();
      const workflowId = orchestrationWorkflowId(id);
      const input: OrchestrationWorkflowInput = {
        orchestrationId: id,
        pinned,
        serviceId: service?.servicePrincipalId ?? null,
        teamId: target.teamId,
        userId: user?.sub ?? null,
      };
      const title = body.task.split('\n')[0]?.slice(0, 80) || 'Orchestration';

      try {
        const result = await launchTrackedWorkflow(
          prisma,
          {
            activeWorkflow: {
              budgetTier: body.budgetTier,
              currentStatus: 'IMPLEMENTING',
              repoId: target.repoId,
              temporalWorkflowId: workflowId,
              workRequestId,
            },
            ...(target.repoId
              ? {
                  knowledgeSourceRepo: {
                    orgId: target.orgId,
                    repoId: target.repoId,
                    teamId: target.teamId,
                  },
                }
              : { knowledgeSourceTeam: { orgId: target.orgId, teamId: target.teamId } }),
            runInput: {
              ...(target.repoId
                ? { connectionId: target.repoId }
                : { billingOrgId: target.orgId, billingTeamId: target.teamId }),
              description: body.task,
              externalTicketId: `orchestration-${id.replace(/-/g, '').slice(0, 8)}`,
              id: workRequestId,
              // The bounds this orchestration launched under; spawn validation reads them here.
              // `mcpLaunched` keeps the MCP delivery and concurrency limits on every later spawn.
              payload: {
                ...(request.mcpBridge ? { mcpLaunched: true } : {}),
                orchestrationId: id,
                pinned,
                requestDigest,
              },
              requestedById: user?.sub ?? null,
              requestedByServiceId: service?.servicePrincipalId ?? null,
              requestPayload: JSON.stringify({ kind: 'orchestration', orchestrationId: id }),
              ticketIsSynthetic: true,
            },
          },
          async () => {
            try {
              await fastify.temporal.signalWithStartOrchestration(id, input, {
                name: ORCHESTRATION_SIGNALS.userMessage,
                payload: { messageId: firstMessageId },
              });
            } catch (err) {
              await prisma.orchestration
                .deleteMany({ where: { id, teamId: target.teamId } })
                .catch(() => undefined);
              throw err;
            }
          },
          {
            audit: { actor: user ?? null, source: 'orchestration' },
            ...(service
              ? {
                  guard: servicePrincipalLaunchGuard(service.servicePrincipalId, {
                    connectionId: target.repoId,
                  }),
                }
              : { guard: mcpWrite.launchGuard }),
            inTransaction: async (tx) => {
              await tx.orchestration.create({
                data: {
                  allowlist,
                  budgetTier: body.budgetTier,
                  connectionIds,
                  deliveryDefault: body.deliveryDefault,
                  id,
                  launchedById: user?.sub ?? null,
                  orgId: target.orgId,
                  repoId: target.repoId,
                  serviceId: service?.servicePrincipalId ?? null,
                  teamId: target.teamId,
                  title,
                  workRequestId,
                },
              });
              await tx.orchestrationMessage.create({
                data: {
                  authorId: user?.sub ?? null,
                  body: body.task,
                  id: firstMessageId,
                  kind: 'TEXT',
                  orchestrationId: id,
                  role: 'USER',
                },
              });
            },
            log: request.log,
            sourceAuthorization: user ? { actor: user } : {},
          }
        );
        if (!result.ok) {
          if (result.reason === 'GUARD_REFUSED') {
            return request.mcpBridge
              ? sendRunCapRefusal(reply)
              : sendServiceLaunchRefusal(reply, result.refusal);
          }
          // A concurrent launch with the same key won the insert: answer with its orchestration.
          if (await replay()) {
            return reply;
          }
          return sendError(reply, 409, 'RUN_CONFLICT', 'This orchestration already exists');
        }
      } catch (err) {
        const sent = replyIfTemporalUnavailable(err, reply);
        if (sent) {
          return sent;
        }
        throw err;
      }
      await audit(request, id, 'launch', {
        allowlist,
        allowlistDefaulted,
        connectionIds,
        repoId: target.repoId,
        service: service?.servicePrincipalId ?? null,
        teamId: target.teamId,
      });
      return reply.status(201).send({
        data: {
          allowlist,
          orchestrationId: id,
          status: 'ACTIVE',
          workflowId,
          writeCapable,
        },
      });
    }
  );

  // ── Reads ─────────────────────────────────────────────────────────────────

  app.get(
    '/',
    {
      config: { mcpScope: 'read', serviceScopes: ['runs:agent'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListQuery },
    },
    async (request) => {
      const caller = requireCaller(request);
      const { limit, offset, status, teamId } = request.query;
      const where = {
        ...(status ? { status } : {}),
        ...(teamId ? { teamId } : {}),
        ...(caller.kind === 'service'
          ? { serviceId: caller.principal.servicePrincipalId }
          : caller.user.role === Role.ADMIN
            ? {}
            : {
                OR: [
                  { launchedById: caller.user.sub },
                  { team: { memberships: { some: { userId: caller.user.sub } } } },
                ],
              }),
      };
      const listSelect = {
        budgetTier: true,
        createdAt: true,
        id: true,
        launchedById: true,
        repo: { select: { organizationName: true, repoName: true } },
        repoAttachedAt: true,
        repoId: true,
        serviceId: true,
        status: true,
        team: { select: { name: true } },
        teamId: true,
        title: true,
        updatedAt: true,
        workRequest: { select: { activeWorkflows: { select: { costUsdAccrued: true } } } },
      } as const;
      const orderBy = [{ updatedAt: 'desc' as const }, { id: 'desc' as const }];
      // The call sites stay lexically inside their wrapper: the tenant-guard coverage test reads
      // them that way. A person's listing is filtered by membership (or is an admin's); a
      // principal's is filtered by its own id.
      const [rows, total] =
        caller.kind === 'service'
          ? await runUnscoped(
              'a service principal lists only the orchestrations it launched, matched by serviceId',
              ['Orchestration'],
              () =>
                Promise.all([
                  prisma.orchestration.findMany({
                    orderBy,
                    select: listSelect,
                    skip: offset,
                    take: limit,
                    where,
                  }),
                  prisma.orchestration.count({ where }),
                ])
            )
          : await asPlatformAdmin(
              caller.user,
              'an admin may list every orchestration',
              ['Orchestration'],
              () =>
                Promise.all([
                  prisma.orchestration.findMany({
                    orderBy,
                    select: listSelect,
                    skip: offset,
                    take: limit,
                    where,
                  }),
                  prisma.orchestration.count({ where }),
                ])
            );
      const ids = rows.map((r) => r.id);
      // The repository's name is shown only to those who can reach the repository.
      const viewer = viewerOf(request);
      const reachable = await reachableRepoIds(
        prisma,
        viewer,
        rows.filter((r) => r.repoId && !launcherSeesRepo(viewer, r)).map((r) => r.repoId as string)
      );
      const children = ids.length
        ? await prisma.orchestrationChild.findMany({
            select: { costUsd: true, orchestrationId: true, status: true },
            where: { orchestrationId: { in: ids } },
          })
        : [];
      const data = rows.map((r) => {
        const mine = children.filter((c) => c.orchestrationId === r.id);
        const own = r.workRequest?.activeWorkflows.reduce((s, w) => s + w.costUsdAccrued, 0) ?? 0;
        return summaryView(
          r,
          {
            childCount: mine.length,
            costUsd: mine.reduce((s, c) => s + c.costUsd, 0) + own,
            runningChildCount: mine.filter((c) =>
              (CHILD_LIVE_STATUSES as readonly string[]).includes(c.status)
            ).length,
          },
          {
            redactRepo:
              !!r.repoId && !launcherSeesRepo(viewer, r) && !reachable.has(r.repoId as string),
          }
        );
      });
      return { data, limit, offset, total };
    }
  );

  // The MCP connections a launcher may put in an orchestration's set: the active ones the named
  // team owns, by name only (never a URL or a secret). Declared before `/:id` so it is not read
  // as an id.
  app.get(
    '/connections',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: z.object({ teamId: z.uuid() }) },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { teamId } = request.query;
      const team = await prisma.team.findFirst({
        select: {
          id: true,
          isActive: true,
          memberships: { select: { userId: true }, where: { userId: user.sub } },
        },
        where: { id: teamId },
      });
      if (!team?.isActive || (team.memberships.length === 0 && user.role !== Role.ADMIN)) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      const rows = await prisma.connection.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
        where: { isActive: true, teamId, type: 'mcp' },
      });
      return { data: rows.map((r) => ({ id: r.id, name: r.name })) };
    }
  );

  // The allowlist a launch with none named would apply, for the launch form to pre-select. By
  // team (for its organization's override) and only for a member; declared before `/:id`.
  app.get(
    '/defaults',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: z.object({ teamId: z.uuid() }) },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { teamId } = request.query;
      const team = await prisma.team.findFirst({
        select: {
          id: true,
          isActive: true,
          memberships: { select: { userId: true }, where: { userId: user.sub } },
          orgId: true,
        },
        where: { id: teamId },
      });
      if (!team?.isActive || (team.memberships.length === 0 && user.role !== Role.ADMIN)) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      const { allowlist, writeCapable } = await resolveDefaults(prisma, {
        orgId: team.orgId,
        teamId: team.id,
      });
      return { data: { allowlist, writeCapable } };
    }
  );

  app.get(
    '/:id',
    {
      config: { mcpScope: 'read', serviceScopes: ['runs:agent'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: IdParams },
    },
    async (request, reply) => {
      const row = await visible(request, request.params.id);
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Orchestration not found');
      }
      const viewer = viewerOf(request);
      const detail = await buildDetail(prisma, row, {
        canControl: launchedByViewer(viewer, row),
        viewer,
      });
      return { data: detail };
    }
  );

  app.get(
    '/:id/messages',
    {
      config: { mcpScope: 'read', serviceScopes: ['runs:agent'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: IdParams, querystring: MessagesQuery },
    },
    async (request, reply) => {
      const row = await visible(request, request.params.id);
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Orchestration not found');
      }
      const { after, limit } = request.query;
      const cursor = after ? decodeCursor(after) : null;
      if (after && !cursor) {
        return sendError(reply, 400, 'INVALID_CURSOR', 'The after cursor is not valid');
      }
      const rows = await prisma.orchestrationMessage.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
        where: {
          orchestrationId: row.id,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
      });
      const last = rows[rows.length - 1];
      const sees = await canSeeRepoData(prisma, viewerOf(request), row);
      return {
        // Hidden marker rows count toward the cursor but are never served.
        data: rows
          .filter((m) => !isHiddenMessage(m))
          .map((m) => (sees ? messageView(m) : redactMessage(messageView(m), row.repoAttachedAt))),
        next: last ? encodeCursor(last) : null,
      };
    }
  );

  // Server-sent events: `message`, `child` and `status` records as they change, `: ping`
  // comments as heartbeats. A client that cannot hold a stream polls the routes above instead.
  // Every event carries `id:` = the transcript cursor (the one `GET /:id/messages` returns as
  // `next`) at the point it was written, so `Last-Event-ID` (or `?after=`) resumes the transcript
  // exactly: messages after that cursor are replayed, none twice. `child` and `status` are state,
  // not history: a fresh stream opens with the current snapshot of each.
  app.get(
    '/:id/events',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        params: IdParams,
        querystring: z.object({ after: z.string().max(512).optional() }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      // The close listener goes on before the first await: a client that disconnects while the
      // handler is still looking the orchestration up must not be given a stream slot or polled.
      let gone = request.raw.destroyed;
      let onGone: (() => void) | undefined;
      const markGone = () => {
        gone = true;
        onGone?.();
      };
      request.raw.once('close', markGone);
      request.raw.once('error', markGone);
      const row = await visible(request, request.params.id);
      if (gone || request.raw.destroyed) {
        reply.hijack();
        return;
      }
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Orchestration not found');
      }
      const lastEventId = request.headers['last-event-id'];
      // EventSource keeps the original URL on reconnect and adds Last-Event-ID, so the header is
      // the newer position when both are present.
      const resumeFrom =
        (typeof lastEventId === 'string' && lastEventId ? lastEventId : undefined) ??
        request.query.after ??
        '';
      const resume = resumeFrom ? decodeCursor(resumeFrom) : null;
      if (resumeFrom && !resume) {
        return sendError(reply, 400, 'INVALID_CURSOR', 'The resume cursor is not valid');
      }
      const openCount = openStreams.get(user.sub) ?? 0;
      if (openCount >= MAX_STREAMS_PER_USER) {
        return sendError(
          reply,
          429,
          'TOO_MANY_STREAMS',
          `At most ${MAX_STREAMS_PER_USER} concurrent orchestration streams per user`
        );
      }
      openStreams.set(user.sub, openCount + 1);
      let slotHeld = true;
      const releaseSlot = () => {
        if (!slotHeld) {
          return;
        }
        slotHeld = false;
        const remaining = (openStreams.get(user.sub) ?? 1) - 1;
        if (remaining <= 0) {
          openStreams.delete(user.sub);
        } else {
          openStreams.set(user.sub, remaining);
        }
      };
      const orchestrationId = row.id;
      const teamId = row.teamId;
      const viewer = viewerOf(request);
      const launchedById = row.launchedById;

      reply.hijack();
      const res = reply.raw;
      try {
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) {
            res.setHeader(name, value as string | number | string[]);
          }
        }
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        // How long a client waits before it reconnects after a drop or the time limit.
        res.write(`retry: ${STREAM_RETRY_MS}\n\n`);
      } catch (err) {
        // A write that fails before the stream is running must not keep the slot.
        releaseSlot();
        request.log.warn({ err }, 'orchestration stream: could not open');
        res.destroy();
        return;
      }

      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = Date.now();
      let lastBeat = started;
      let lastAccessCheck = started;
      let cursor: { createdAt: Date; id: string } | null = resume;
      let lastStatus = '';
      const lastChild = new Map<string, string>();
      const write = (event: string, data: unknown) => {
        if (!res.writableEnded) {
          const id = cursor ? `id: ${encodeCursor(cursor)}\n` : '';
          res.write(`${id}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      return new Promise<void>((resolve) => {
        const finish = () => {
          if (closed) {
            return;
          }
          closed = true;
          if (timer) {
            clearTimeout(timer);
          }
          releaseSlot();
          try {
            if (!res.writableEnded) {
              res.end();
            }
          } catch {
            // The socket is already gone; the slot and the timer are released either way.
          }
          resolve();
        };
        onGone = finish;
        res.once('close', finish);
        if (gone || request.raw.destroyed) {
          finish();
          return;
        }

        const poll = async () => {
          if (closed) {
            return;
          }
          if (Date.now() - started > STREAM_MAX_MS) {
            write('done', { reason: 'timeout' });
            finish();
            return;
          }
          try {
            if (Date.now() - lastAccessCheck >= STREAM_ACCESS_RECHECK_MS) {
              // Authorization is not only a property of the open: a viewer removed from the team
              // or the launch since then is told and cut off.
              const stillVisible = await visible(request, orchestrationId);
              if (closed) {
                return;
              }
              if (!stillVisible) {
                write('done', { reason: 'access' });
                finish();
                return;
              }
              lastAccessCheck = Date.now();
            }
            const messages = await prisma.orchestrationMessage.findMany({
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: 100,
              where: {
                orchestrationId,
                ...(cursor
                  ? {
                      OR: [
                        { createdAt: { gt: cursor.createdAt } },
                        { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                      ],
                    }
                  : {}),
              },
            });
            // The repository may be attached while the stream is open: ask each poll.
            const live = await prisma.orchestration.findFirst({
              select: { repoAttachedAt: true, repoId: true, status: true },
              where: { id: orchestrationId, teamId },
            });
            if (closed) {
              return;
            }
            if (!live) {
              finish();
              return;
            }
            const sees = await canSeeRepoData(prisma, viewer, {
              launchedById,
              repoId: live.repoId,
            });
            if (closed) {
              return;
            }
            for (const m of messages) {
              // The cursor moves first, so the event's id names this message.
              cursor = { createdAt: m.createdAt, id: m.id };
              if (!isHiddenMessage(m)) {
                write(
                  'message',
                  sees ? messageView(m) : redactMessage(messageView(m), live.repoAttachedAt)
                );
              }
            }
            const children = await prisma.orchestrationChild.findMany({
              include: {
                workRequest: {
                  select: {
                    activeWorkflows: { select: { assignedBranch: true, costUsdAccrued: true } },
                  },
                },
              },
              orderBy: { createdAt: 'asc' },
              where: { orchestrationId },
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
            if (closed) {
              return;
            }
            for (const [index, c] of children.entries()) {
              const view = childView(c as never, c.runId ? (undelivered.get(c.runId) ?? 0) : 0, {
                ordinal: index + 1,
                redactRepo: !sees,
              });
              const serialized = JSON.stringify(view);
              if (lastChild.get(c.id) !== serialized) {
                lastChild.set(c.id, serialized);
                write('child', view);
              }
            }
            if (live.status !== lastStatus) {
              lastStatus = live.status;
              write('status', { status: live.status });
            }
            if (Date.now() - lastBeat >= STREAM_HEARTBEAT_MS && !res.writableEnded) {
              res.write(': ping\n\n');
              lastBeat = Date.now();
            }
          } catch (err) {
            request.log.warn({ err }, 'orchestration stream: poll failed');
            if (res.destroyed || res.writableEnded) {
              // A write that threw mid-stream: the socket is gone, so stop polling it.
              finish();
              return;
            }
          }
          if (!closed) {
            timer = setTimeout(poll, STREAM_POLL_MS);
          }
        };
        void poll();
      });
    }
  );

  // ── Messages ──────────────────────────────────────────────────────────────

  app.post(
    '/:id/messages',
    {
      config: { mcpScope: 'write', serviceScopes: ['runs:agent'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      onSend: mcpWriteAuditHook,
      preValidation: mcpWriteBegin('orchestrations_message'),
      schema: { body: OrchestrationBodySchema, params: IdParams },
    },
    async (request, reply) => {
      const mcpWrite = await assertMcpWriteAllowed(request, reply, {
        tool: 'orchestrations_message',
      });
      if (mcpWrite.refused) {
        return mcpWrite.refused;
      }
      const caller = requireCaller(request);
      // A service principal's message has no author: the launching principal is on the audit entry.
      const authorId = caller.kind === 'user' ? caller.user.sub : null;
      const row = await controlOwned(request, reply, request.params.id);
      if (!row) {
        return reply;
      }
      // A quiet orchestration that completed starts again on a new message; a cancelled or
      // failed one does not.
      // A bridged (MCP) caller may not restart one: that passes no concurrency check, so it stays
      // a dashboard or CLI act.
      if (
        (row.status !== 'COMPLETED' || request.mcpBridge) &&
        !ORCHESTRATION_LIVE_STATUSES.includes(row.status as never)
      ) {
        return refusal(reply, 409, 'ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
      }
      const on = await switchOn(request, reply);
      if (on === 'sent') {
        return reply;
      }
      if (!on) {
        return sendError(reply, 403, 'ORCHESTRATION_DISABLED', 'Orchestrated runs are turned off');
      }
      if (await mcpDeliveryRefusal(request, reply, row.deliveryDefault)) {
        return reply;
      }
      // A signal to a WAITING (or revived COMPLETED) orchestration starts a new execution; for a
      // bridged caller that counts against the launcher's cap, checked in the same transaction
      // that reopens the ledger row, before anything is sent.
      const wake = await prepareWake(row, {
        cap:
          request.mcpBridge && authorId
            ? {
                cap: (await resolveSettings(['mcp.maxConcurrentRuns']))['mcp.maxConcurrentRuns'],
                userId: authorId,
              }
            : null,
        guard:
          caller.kind === 'service'
            ? servicePrincipalLaunchGuard(caller.principal.servicePrincipalId, {
                connectionId: row.repoId,
              })
            : null,
        revive: !request.mcpBridge,
      });
      if (wake.kind === 'capped') {
        return sendRunCapRefusal(reply);
      }
      if (wake.kind === 'refused') {
        return sendServiceLaunchRefusal(reply, wake.refusal);
      }
      if (wake.kind === 'ended') {
        return refusal(reply, 409, 'ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
      }
      const message = await prisma.orchestrationMessage.create({
        data: {
          authorId,
          body: request.body.body,
          kind: 'TEXT',
          orchestrationId: row.id,
          role: 'USER',
        },
      });
      try {
        await fastify.temporal.signalWithStartOrchestration(row.id, await workflowInput(row), {
          name: ORCHESTRATION_SIGNALS.userMessage,
          payload: { messageId: message.id },
        });
      } catch (err) {
        // Undo, so the person can send it again: the orchestrator never saw it.
        await prisma.orchestrationMessage.deleteMany({ where: { id: message.id } });
        await undoWake(request, row, wake);
        if (isTemporalUnavailable(err)) {
          return sendTemporalUnavailable(reply);
        }
        throw err;
      }
      await audit(request, row.id, 'steer', { messageId: message.id, target: 'orchestrator' });
      return reply.status(201).send({ data: messageView(message) });
    }
  );

  // A message to one child: the launcher (a session) or the orchestrator's `messageAgent`
  // intent (the orchestration token). Delivered at the child's next step boundary.
  app.post(
    '/:id/children/:childId/messages',
    {
      config: { mcpScope: 'write', orchestrationToken: 'caller', serviceScopes: ['runs:agent'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      onSend: mcpWriteAuditHook,
      preValidation: mcpWriteBegin('orchestrations_message'),
      schema: { body: OrchestrationBodySchema, params: ChildParams },
    },
    async (request, reply) => {
      const mcpWrite = await assertMcpWriteAllowed(request, reply, {
        tool: 'orchestrations_message',
      });
      if (mcpWrite.refused) {
        return mcpWrite.refused;
      }
      const byOrchestrator = request.orchestration !== undefined;
      const orch = byOrchestrator
        ? await prisma.orchestration.findFirst({
            select: { deliveryDefault: true, id: true, status: true, teamId: true },
            where: { id: request.params.id },
          })
        : await controlOwned(request, reply, request.params.id);
      if (!orch) {
        return byOrchestrator
          ? sendError(reply, 404, 'NOT_FOUND', 'Orchestration not found')
          : reply;
      }
      if (!ORCHESTRATION_LIVE_STATUSES.includes(orch.status as never)) {
        return refusal(reply, 409, 'ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
      }
      if (await mcpDeliveryRefusal(request, reply, orch.deliveryDefault)) {
        return reply;
      }
      const child = await prisma.orchestrationChild.findFirst({
        select: { id: true, runId: true, status: true },
        where: { id: request.params.childId, orchestrationId: orch.id },
      });
      if (!child) {
        return sendError(reply, 404, 'NOT_FOUND', 'Child not found');
      }
      if (!(CHILD_LIVE_STATUSES as readonly string[]).includes(child.status)) {
        return refusal(reply, 409, 'CHILD_NOT_ALLOWED', 'That agent has already finished');
      }
      if (!child.runId) {
        return refusal(
          reply,
          409,
          'CHILD_NOT_ALLOWED',
          'That agent has not started its run yet; try again shortly'
        );
      }
      const authorId = byOrchestrator ? null : (request.user?.sub ?? null);
      // A launching principal's word is the launcher's: it carries its id, so the child's drain
      // labels it `launcher`, not the orchestrator's (a row with neither author).
      const authorServiceId = byOrchestrator
        ? null
        : (request.principal?.servicePrincipalId ?? null);
      await prisma.runSteeringMessage.create({
        data: { authorId, authorServiceId, body: request.body.body, runId: child.runId },
      });
      const message = await prisma.orchestrationMessage.create({
        data: {
          authorId,
          body: request.body.body,
          childId: child.id,
          kind: 'TEXT',
          orchestrationId: orch.id,
          role: byOrchestrator ? 'ORCHESTRATOR' : 'USER',
        },
      });
      // Tell the orchestrator when the person steers a child, so its picture stays coherent.
      if (!byOrchestrator) {
        try {
          await signalIfRunning(request, orch.id, ORCHESTRATION_SIGNALS.userMessage, {
            messageId: message.id,
          });
        } catch (err) {
          request.log.warn({ err }, 'the orchestrator was not told about a steering message');
        }
      }
      await audit(request, orch.id, 'steer', {
        byOrchestrator,
        childId: child.id,
        messageId: message.id,
      });
      return reply.status(201).send({ data: messageView(message) });
    }
  );

  // ── Spawn (orchestration token only) ───────────────────────────────────────

  app.post(
    '/:id/children',
    {
      config: { orchestrationToken: 'caller' },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      onSend: async (_request, reply, payload) => normalizeRefusalBody(reply.statusCode, payload),
      schema: { body: SpawnBody, headers: IdempotencyHeaderSchema, params: IdParams },
    },
    async (request, reply) => {
      if (!request.orchestration) {
        return sendError(
          reply,
          403,
          'ORCHESTRATION_TOKEN_REQUIRED',
          'Children are started by the orchestrator, with its orchestration token'
        );
      }
      const caller = requireCaller(request);
      const parsedIntent = SpawnIntentSchema.safeParse(request.body.intent);
      if (!parsedIntent.success) {
        return reply.status(422).send({
          error: {
            code: 'INVALID_INTENT',
            details: parsedIntent.error.issues.map((i) => ({
              message: i.message,
              path: i.path.join('.'),
            })),
            message: 'The spawn intent is malformed',
          },
        });
      }
      const intent = parsedIntent.data;
      const orch = await prisma.orchestration.findFirst({
        select: {
          allowlist: true,
          budgetTier: true,
          connectionIds: true,
          deliveryDefault: true,
          id: true,
          launchedById: true,
          orgId: true,
          repoId: true,
          status: true,
          teamId: true,
          workRequest: { select: { payload: true } },
        },
        where: { id: request.params.id },
      });
      if (!orch) {
        return sendError(reply, 404, 'NOT_FOUND', 'Orchestration not found');
      }

      // One audit entry per refusal, however it was reached.
      let audited = false;
      const refuse = async (code: string, message: string) => {
        if (!audited) {
          audited = true;
          await audit(request, orch.id, 'refusal', {
            agent: intent.agent,
            code,
            role: intent.role,
          });
        }
        return refusal(reply, 409, code, message);
      };

      // 1. Active, and the kill switch is on.
      if (!ORCHESTRATION_LIVE_STATUSES.includes(orch.status as never)) {
        return refuse('ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
      }
      const on = await switchOn(request, reply);
      if (on === 'sent') {
        return reply;
      }
      if (!on) {
        return refuse('ORCHESTRATION_NOT_ACTIVE', 'Orchestrated runs are turned off');
      }

      // A retried spawn (the same turn key) is answered with the child its first attempt started,
      // before any width or scope check: those would count that very child against the retry.
      // The id is the one the launch derives; a child started before a repository was attached
      // was keyed on the named team, so both are tried.
      const spawnKey = `${orch.id}:${request.body.turnKey}`;
      for (const scopeId of new Set([orch.repoId, orch.teamId])) {
        if (!scopeId) {
          continue;
        }
        const replayed = await findChildByWorkflow(
          orch.id,
          agentRunWorkflowId(scopeId, caller, spawnKey)
        );
        if (replayed) {
          return reply.status(200).send(replayed);
        }
      }

      // 2. Allowlist: the exact reference the launcher approved, and still launchable.
      const { key } = splitRef(intent.agent);
      const lowered = key.trim().toLowerCase();
      if (
        !orch.allowlist.includes(intent.agent) ||
        !isLaunchableAgentKey(key) ||
        [...NON_LAUNCHABLE_AGENT_KEYS].some((k) => k.toLowerCase() === lowered)
      ) {
        return refuse(
          'CHILD_NOT_ALLOWED',
          `Agent '${intent.agent}' is not on this orchestration's allowlist`
        );
      }

      // 3. Width, against the bounds this orchestration launched under (not the live registry).
      const pins = await storedPins(orch.workRequest, {
        orgId: orch.orgId ?? undefined,
        teamId: orch.teamId,
      });
      const loadChildren = (db: Pick<typeof prisma, 'orchestrationChild'>) =>
        db.orchestrationChild.findMany({
          select: { pathScopes: true, role: true, status: true },
          where: { orchestrationId: orch.id },
        });
      const existing = await loadChildren(prisma);

      // 4. Role rules.
      const writer = intent.role === 'writer';
      const scopesIn = intent.pathScopes ?? [];
      if (writer) {
        if (!orch.repoId) {
          return refuse(
            'REPO_REQUIRED',
            'A writer needs a repository; ask the launcher to attach one'
          );
        }
        if (
          (intent.deliver !== 'branch' && intent.deliver !== 'draft_pr') ||
          scopesIn.length === 0
        ) {
          return refuse(
            'ROLE_RULE_VIOLATED',
            'A writer needs deliver "branch" or "draft_pr" and path scopes'
          );
        }
      } else if ((intent.deliver && intent.deliver !== 'none') || scopesIn.length > 0) {
        return refuse('ROLE_RULE_VIOLATED', 'A reader delivers nothing and has no path scopes');
      }

      // 4b. An orchestration launched through MCP stays inside the MCP delivery policy for every
      // child: the live allowlist of modes, and never more than the launch default allowed.
      const mcpLaunched =
        (orch.workRequest?.payload as { mcpLaunched?: unknown } | null | undefined)?.mcpLaunched ===
        true;
      if (mcpLaunched && writer) {
        const modes = (await resolveSettings(['mcp.agentRunAllowedDeliverModes']))[
          'mcp.agentRunAllowedDeliverModes'
        ];
        const rank = (m: string | null | undefined) => DELIVER_RANK.indexOf(m ?? 'none');
        if (
          !modes.includes(intent.deliver as string) ||
          rank(intent.deliver) > rank(orch.deliveryDefault)
        ) {
          return refuse(
            'CHILD_NOT_ALLOWED',
            `This orchestration was launched through MCP: a writer's delivery mode must be allowed by the MCP delivery restriction and no broader than the launch default (${orch.deliveryDefault ?? 'none'})`
          );
        }
      }

      // 5. Scopes.
      const liveWriters = existing.filter(
        (c) => c.role === 'WRITER' && (CHILD_LIVE_STATUSES as readonly string[]).includes(c.status)
      );
      let candidate: ParsedScope[] = [];
      let namesSharedFile = false;
      if (writer) {
        const syntax = validatePathScopes(scopesIn, { isOwnerOfSharedFiles: true });
        if (!syntax.ok) {
          return refuse('ROLE_RULE_VIOLATED', `Invalid path scopes: ${syntax.errors.join('; ')}`);
        }
        candidate = syntax.scopes;
        namesSharedFile = !validatePathScopes(scopesIn).ok;
        if (namesSharedFile && liveWriters.some(holdsSharedFile)) {
          return refuse('SCOPE_OVERLAP', 'Another running writer already owns the shared files');
        }
      }
      const bounds = checkSpawnBounds(existing, pins, {
        role: intent.role,
        scopes: candidate,
        sharedOwner: true,
      });
      if (bounds) {
        return refuse(bounds.code, bounds.message);
      }
      const overlapOf = (rows: typeof liveWriters) => {
        const groups = rows.map((w) => parseStoredScopes(w.pathScopes));
        if (groups.some((g) => g.unparsable)) {
          return 0;
        }
        return firstOverlap(
          groups.map((g) => g.parsed),
          candidate
        );
      };
      if (writer && overlapOf(liveWriters) !== null) {
        return refuse('SCOPE_OVERLAP', 'Those paths overlap a running writer; narrow them or wait');
      }

      // 7 (early). The agent's MCP connection must be in the launch-time set.
      const agentRows = await runUnscoped(
        'an agent run resolves its agent at GLOBAL and ORGANIZATION scope only',
        ['Agent'],
        () =>
          prisma.agent.findMany({
            orderBy: { version: 'desc' },
            select: { mcpConnectionId: true, scope: true, version: true },
            where: { isActive: true, key, OR: agentScopeBranches(orch.orgId) },
          })
      );
      const { version: pinned } = splitRef(intent.agent);
      const effective =
        agentRows.find((a) => a.scope === 'ORGANIZATION') ??
        (pinned === undefined
          ? agentRows.find((a) => a.scope === 'GLOBAL')
          : agentRows.find((a) => a.scope === 'GLOBAL' && a.version === pinned));
      if (effective?.mcpConnectionId && !orch.connectionIds.includes(effective.mcpConnectionId)) {
        return refuse(
          'CONNECTION_NOT_IN_SET',
          "That agent's MCP connection is not in this orchestration's connection set"
        );
      }

      if (intent.task.length > AGENT_RUN_MAX_PROMPT_CHARS) {
        return sendError(reply, 422, 'INVALID_INTENT', 'The task is too long');
      }

      // 5-6. Authorization and admission are the agent-run launch's own, as the launcher.
      const childId = randomUUID();
      const repoless = orch.repoId ? undefined : { teamId: orch.teamId };
      await launchAgentRun(request, reply, {
        agent: intent.agent,
        budgetTier: orch.budgetTier as BudgetTier,
        caller,
        deliver: intent.deliver ?? 'none',
        idempotencyKey: `${orch.id}:${request.body.turnKey}`,
        ...(intent.maxSteps ? { maxSteps: intent.maxSteps } : {}),
        orchestration: {
          afterStart: async ({ temporalWorkflowId, workRequestId }) => {
            // A cancel or end between the child row and the workflow start swept a workflow that
            // did not exist yet. Look again now that it does.
            const now = await prisma.orchestration.findFirst({
              select: { status: true },
              where: { id: orch.id, teamId: orch.teamId },
            });
            if (now && ORCHESTRATION_LIVE_STATUSES.includes(now.status as never)) {
              return null;
            }
            try {
              await cancelRun(temporalWorkflowId);
              await prisma.orchestrationChild.updateMany({
                data: { endedAt: new Date(), status: 'CANCELLED' },
                where: {
                  orchestrationId: orch.id,
                  status: { in: [...CHILD_LIVE_STATUSES] },
                  workRequestId,
                },
              });
            } catch (err) {
              // The workflow may still be running: do not mark the child finished (its result
              // would be dropped and its writer scopes stop counting). The row stays STARTING for
              // the cancel/end second sweep and the worker's refresh to finish.
              request.log.error({ err, temporalWorkflowId }, 'late child cancel failed');
            }
            return {
              code: 'ORCHESTRATION_NOT_ACTIVE',
              message: 'This orchestration ended while the agent was starting; it was cancelled',
              status: 409,
            };
          },
          // MCP-launched: the child counts against the launcher's MCP concurrency cap, under the
          // same transactional guard the launch used.
          ...(mcpLaunched && orch.launchedById
            ? {
                guard: runCapGuard(
                  orch.launchedById,
                  (await resolveSettings(['mcp.maxConcurrentRuns']))['mcp.maxConcurrentRuns']
                ),
              }
            : {}),
          checkRepo: async (repo) => {
            if (!writer) {
              return null;
            }
            // A service principal holds no GitHub identity, so there is no push permission to ask
            // about. What authorizes its writer is the launch decision that already ran for this
            // child (`authorizeAgentRunRepo`: the repository is on its allowlist and its team owns
            // it or has it shared) and its launch guard; the push policy, the path scopes and the
            // security gate still apply to the delivery. Push permission is a person's check.
            if (caller.kind === 'service') {
              return null;
            }
            const denied = (await checkPushPermission(prisma, caller.user.sub, repo)) as {
              ok: boolean;
              reason?: string;
            };
            if (!denied.ok) {
              return {
                code: 'PUSH_PERMISSION_REQUIRED',
                message: `The launcher needs GitHub push permission to run a writer (${denied.reason})`,
                status: 409,
              };
            }
            return null;
          },
          existing: (workflowId) => findChildByWorkflow(orch.id, workflowId),
          inTransaction: async (tx, ids) => {
            // CLAUDE.md §7 exception: serialize concurrent spawns of one orchestration so the
            // width and scope checks below see each other's children; Prisma cannot express
            // SELECT … FOR UPDATE.
            await tx.$queryRaw`SELECT id FROM orchestrations WHERE id = ${orch.id}::uuid FOR UPDATE`;
            const current = await tx.orchestration.findFirst({
              select: { repoId: true, status: true },
              where: { id: orch.id, teamId: orch.teamId },
            });
            if (!current || !ORCHESTRATION_LIVE_STATUSES.includes(current.status as never)) {
              throw new SpawnRefusal('ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
            }
            // The repository this launch was authorized against must still be the attached one (a
            // failed attach can be rolled back under this same lock).
            if ((writer || orch.repoId) && current.repoId !== orch.repoId) {
              throw new SpawnRefusal(
                'REPO_REQUIRED',
                "The orchestration's repository changed while the agent was starting; try again"
              );
            }
            const now = await loadChildren(tx as never);
            const again = checkSpawnBounds(now, pins, {
              role: intent.role,
              scopes: candidate,
              sharedOwner: true,
            });
            if (again) {
              throw new SpawnRefusal(again.code, again.message);
            }
            const writers = now.filter(
              (c) =>
                c.role === 'WRITER' && (CHILD_LIVE_STATUSES as readonly string[]).includes(c.status)
            );
            if (writer && namesSharedFile && writers.some(holdsSharedFile)) {
              throw new SpawnRefusal(
                'SCOPE_OVERLAP',
                'Another running writer already owns the shared files'
              );
            }
            if (writer && overlapOf(writers) !== null) {
              throw new SpawnRefusal('SCOPE_OVERLAP', 'Those paths overlap a running writer');
            }
            await tx.orchestrationChild.create({
              data: {
                agentKey: key,
                id: childId,
                label: intent.label,
                orchestrationId: orch.id,
                pathScopes: writer
                  ? candidate.map((s) => (s.kind === 'tree' ? `${s.path}/**` : s.path))
                  : [],
                role: writer ? 'WRITER' : 'READER',
                status: 'STARTING',
                workRequestId: ids.workRequestId,
              },
            });
            await writeAuditLog(fastify, {
              action: 'UPDATE',
              actor: request.user ?? null,
              after: {
                action: 'spawn',
                agent: intent.agent,
                childId,
                role: intent.role,
                ...(request.principal ? { serviceId: request.principal.servicePrincipalId } : {}),
              },
              client: tx as never,
              entityId: orch.id,
              entityType: 'Orchestration',
            });
          },
          onStartFailed: async (workRequestId) => {
            await prisma.orchestrationChild.deleteMany({
              where: { orchestrationId: orch.id, workRequestId },
            });
          },
          orchestrationId: orch.id,
          parentWorkflowId: orchestrationWorkflowId(orch.id),
          pathScopes: writer ? scopesIn : [],
          respond: ({ clamped, temporalWorkflowId, workRequestId }) => ({
            data: {
              childId,
              ...(clamped ? { clamped } : {}),
              workflowId: temporalWorkflowId,
              workRequestId,
            },
          }),
          ...(repoless ? { repoless } : {}),
        },
        prompt: intent.task,
        ...(orch.repoId ? { repoId: orch.repoId } : {}),
      }).catch(async (err: unknown) => {
        if (err instanceof SpawnRefusal) {
          return refuse(err.code, err.message);
        }
        throw err;
      });
      if (reply.statusCode >= 400 && !audited) {
        audited = true;
        await audit(request, orch.id, 'refusal', {
          agent: intent.agent,
          status: reply.statusCode,
        });
      }
      return reply;
    }
  );

  // Cancel one child: the launcher, or the orchestrator's `cancelAgent` (token).
  app.post(
    '/:id/children/:childId/cancel',
    {
      config: { orchestrationToken: 'caller', serviceScopes: ['runs:agent'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: ChildParams },
    },
    async (request, reply) => {
      const byOrchestrator = request.orchestration !== undefined;
      const orch = byOrchestrator
        ? await prisma.orchestration.findFirst({
            select: { id: true, status: true },
            where: { id: request.params.id },
          })
        : await controlOwned(request, reply, request.params.id);
      if (!orch) {
        return byOrchestrator
          ? sendError(reply, 404, 'NOT_FOUND', 'Orchestration not found')
          : reply;
      }
      const child = await prisma.orchestrationChild.findFirst({
        select: {
          id: true,
          status: true,
          workRequest: { select: { activeWorkflows: { select: { temporalWorkflowId: true } } } },
        },
        where: { id: request.params.childId, orchestrationId: orch.id },
      });
      if (!child) {
        return sendError(reply, 404, 'NOT_FOUND', 'Child not found');
      }
      if (!(CHILD_LIVE_STATUSES as readonly string[]).includes(child.status)) {
        return refusal(reply, 409, 'CHILD_NOT_ALLOWED', 'That agent has already finished');
      }
      try {
        for (const wf of child.workRequest.activeWorkflows) {
          await cancelRun(wf.temporalWorkflowId);
        }
      } catch (err) {
        if (isTemporalUnavailable(err)) {
          return sendTemporalUnavailable(reply);
        }
        request.log.error({ err }, 'child cancel failed');
        return sendError(
          reply,
          502,
          'TEMPORAL_CANCEL_FAILED',
          'Could not cancel the child; try again'
        );
      }
      await audit(request, orch.id, 'cancel', {
        byOrchestrator,
        childId: child.id,
        scope: 'child',
      });
      return { data: { cancelled: true, childId: child.id } };
    }
  );

  // ── Repository attach (launcher only; never the assistant, never a token) ──

  async function pendingAttach(orchestrationId: string) {
    const msg = await prisma.orchestrationMessage.findFirst({
      orderBy: { createdAt: 'desc' },
      where: { kind: 'ATTACH_REQUEST', orchestrationId },
    });
    const payload = (msg?.payload ?? {}) as Record<string, unknown>;
    return msg && isAttachRequestPending(payload) ? { msg, payload } : null;
  }

  /**
   * Resolve the pending ATTACH_REQUEST exactly once. Attach and decline both go through here: the
   * message row is locked, its payload re-read under the lock, and `resolve` runs only if it is
   * still pending, so of two concurrent resolutions exactly one wins and the other is refused.
   * `resolve` writes in the same transaction (attach sets the repository there).
   */
  async function resolveAttachRequest<T>(
    messageId: string,
    resolve: (tx: Prisma.TransactionClient, current: Record<string, unknown>) => Promise<T>
  ): Promise<{ previous: Record<string, unknown>; value: T }> {
    return prisma.$transaction(async (tx) => {
      // CLAUDE.md §7 exception: serialize the two resolutions of one attach request;
      // Prisma cannot express SELECT … FOR UPDATE.
      await tx.$queryRaw`SELECT id FROM orchestration_messages WHERE id = ${messageId}::uuid FOR UPDATE`;
      const fresh = await tx.orchestrationMessage.findFirst({ where: { id: messageId } });
      const previous = (fresh?.payload ?? {}) as Record<string, unknown>;
      if (!fresh || !isAttachRequestPending(previous)) {
        throw new ResolveRefusal(
          409,
          'NO_PENDING_ATTACH',
          'That repository request was already resolved'
        );
      }
      return { previous, value: await resolve(tx, previous) };
    });
  }

  function sendResolveRefusal(reply: FastifyReply, err: unknown) {
    if (err instanceof ResolveRefusal) {
      return err.code === 'REPO_ALREADY_ATTACHED'
        ? refusal(reply, err.status, err.code, err.message)
        : sendError(reply, err.status, err.code, err.message);
    }
    return null;
  }

  app.post(
    '/:id/attach',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: AttachRepoBodySchema, params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await launcherOwned(request, reply, request.params.id);
      if (!row) {
        return reply;
      }
      if (!ORCHESTRATION_LIVE_STATUSES.includes(row.status as never)) {
        return refusal(reply, 409, 'ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
      }
      if (row.repoId) {
        return refusal(reply, 409, 'REPO_ALREADY_ATTACHED', 'A repository is already attached');
      }
      const pending = await pendingAttach(row.id);
      if (!pending) {
        return sendError(
          reply,
          409,
          'NO_PENDING_ATTACH',
          'The orchestrator has not asked for a repository'
        );
      }
      // The full agent-run launch authorization, at this moment.
      const repo = await authorizeAgentRunRepo(fastify, request, reply, {
        caller: { kind: 'user', user },
        repoId: request.body.repoId,
      });
      if (!repo) {
        return reply;
      }
      const attachedAt = new Date();
      let previous: Record<string, unknown>;
      try {
        // One transaction: the request is still pending, `repoId` is still null (the
        // compare-and-set that lets exactly one attach match), and the request is marked resolved.
        ({ previous } = await resolveAttachRequest(pending.msg.id, async (tx, current) => {
          const { count } = await tx.orchestration.updateMany({
            data: { repoAttachedAt: attachedAt, repoId: repo.id },
            where: {
              id: row.id,
              repoId: null,
              status: { in: [...ORCHESTRATION_LIVE_STATUSES] },
              teamId: row.teamId,
            },
          });
          if (count !== 1) {
            throw new ResolveRefusal(
              409,
              'REPO_ALREADY_ATTACHED',
              'A repository is already attached'
            );
          }
          await tx.orchestrationMessage.update({
            data: {
              payload: {
                ...current,
                repoId: repo.id,
                resolution: 'ATTACHED',
                resolvedAt: attachedAt.toISOString(),
              },
            },
            where: { id: pending.msg.id },
          });
        }));
      } catch (err) {
        const sent = sendResolveRefusal(reply, err);
        if (sent) {
          return sent;
        }
        throw err;
      }
      try {
        await fastify.temporal.signalWithStartOrchestration(row.id, await workflowInput(row), {
          name: ORCHESTRATION_SIGNALS.attachResolved,
          payload: { accepted: true, messageId: pending.msg.id, repoId: repo.id },
        });
        // The orchestration wakes: it counts as in flight again.
        await reopenLedger(request, row);
      } catch (err) {
        // The workflow never learned of it. Undo, so the person can try again, unless a writer
        // has already been started against the repository in the meantime: then the attach
        // stands (a rollback would leave a writer on a repository the orchestration no longer
        // has). Any child still running counts, reader or writer: a reader started after the
        // attach already reads the repository. Under the orchestration's row lock, the same
        // one a spawn takes.
        const undone = await prisma.$transaction(async (tx) => {
          // CLAUDE.md §7 exception: the same row lock a spawn holds while it writes its child.
          await tx.$queryRaw`SELECT id FROM orchestrations WHERE id = ${row.id}::uuid FOR UPDATE`;
          const live = await tx.orchestrationChild.count({
            where: { orchestrationId: row.id, status: { in: [...CHILD_LIVE_STATUSES] } },
          });
          if (live > 0) {
            return false;
          }
          await tx.orchestration.updateMany({
            data: { repoAttachedAt: null, repoId: null },
            where: { id: row.id, repoId: repo.id, teamId: row.teamId },
          });
          await tx.orchestrationMessage.update({
            data: { payload: previous as never },
            where: { id: pending.msg.id },
          });
          return true;
        });
        if (undone) {
          if (isTemporalUnavailable(err)) {
            return sendTemporalUnavailable(reply);
          }
          throw err;
        }
        request.log.error(
          { err, orchestrationId: row.id },
          'attach stands but the workflow was not signalled: a child already runs on it'
        );
        await audit(request, row.id, 'attach', {
          accepted: true,
          repoId: repo.id,
          signalled: false,
        });
        return sendError(
          reply,
          502,
          'ATTACH_SIGNAL_FAILED',
          'The repository is attached, but the orchestrator could not be told yet; it will see the repository on its next refresh'
        );
      }
      await audit(request, row.id, 'attach', { accepted: true, repoId: repo.id });
      return {
        data: {
          orchestrationId: row.id,
          repoAttachedAt: attachedAt.toISOString(),
          repoId: repo.id,
        },
      };
    }
  );

  app.post(
    '/:id/attach/decline',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }), schema: { params: IdParams } },
    async (request, reply) => {
      const row = await launcherOwned(request, reply, request.params.id);
      if (!row) {
        return reply;
      }
      if (!ORCHESTRATION_LIVE_STATUSES.includes(row.status as never)) {
        return refusal(reply, 409, 'ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
      }
      const pending = row.repoId ? null : await pendingAttach(row.id);
      if (!pending) {
        return sendError(
          reply,
          409,
          'NO_PENDING_ATTACH',
          'There is no repository request to decline'
        );
      }
      let previous: Record<string, unknown>;
      try {
        ({ previous } = await resolveAttachRequest(pending.msg.id, async (tx, current) => {
          await tx.orchestrationMessage.update({
            data: {
              payload: {
                ...current,
                resolution: 'DECLINED',
                resolvedAt: new Date().toISOString(),
              },
            },
            where: { id: pending.msg.id },
          });
        }));
      } catch (err) {
        const sent = sendResolveRefusal(reply, err);
        if (sent) {
          return sent;
        }
        throw err;
      }
      try {
        await fastify.temporal.signalWithStartOrchestration(row.id, await workflowInput(row), {
          name: ORCHESTRATION_SIGNALS.attachResolved,
          payload: { accepted: false, messageId: pending.msg.id, repoId: null },
        });
        // The orchestration wakes: it counts as in flight again.
        await reopenLedger(request, row);
      } catch (err) {
        // Reopen the request so the person can decide again, unless it was resolved since.
        await prisma
          .$transaction(async (tx) => {
            // CLAUDE.md §7 exception: the same lock the resolution takes.
            await tx.$queryRaw`SELECT id FROM orchestration_messages WHERE id = ${pending.msg.id}::uuid FOR UPDATE`;
            const fresh = await tx.orchestrationMessage.findFirst({
              where: { id: pending.msg.id },
            });
            if ((fresh?.payload as Record<string, unknown> | null)?.resolution === 'DECLINED') {
              await tx.orchestrationMessage.update({
                data: { payload: previous as never },
                where: { id: pending.msg.id },
              });
            }
          })
          .catch(() => undefined);
        if (isTemporalUnavailable(err)) {
          return sendTemporalUnavailable(reply);
        }
        throw err;
      }
      await audit(request, row.id, 'attach', { accepted: false });
      return { data: { declined: true } };
    }
  );

  // ── Approvals (launcher only; never the assistant, never a token) ──────────

  app.post(
    '/:id/approvals/:approvalId',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: ApprovalDecisionBodySchema, params: ApprovalParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await launcherOwned(request, reply, request.params.id);
      if (!row) {
        return reply;
      }
      if (!ORCHESTRATION_LIVE_STATUSES.includes(row.status as never)) {
        return refusal(reply, 409, 'ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
      }
      const approval = await prisma.orchestrationApproval.findFirst({
        select: { id: true },
        where: { id: request.params.approvalId, orchestrationId: row.id },
      });
      if (!approval) {
        return sendError(reply, 404, 'NOT_FOUND', 'Approval not found');
      }
      const status = request.body.decision === 'APPROVE' ? 'APPROVED' : 'DENIED';
      const now = new Date();
      // Compare-and-set: decided once, and never after it expired.
      const { count } = await prisma.orchestrationApproval.updateMany({
        data: { decidedAt: now, decidedById: user.sub, status },
        where: {
          expiresAt: { gt: now },
          id: approval.id,
          orchestrationId: row.id,
          status: 'PENDING',
        },
      });
      if (count !== 1) {
        return sendError(
          reply,
          409,
          'APPROVAL_NOT_PENDING',
          'That approval was already decided or has expired'
        );
      }
      try {
        await signalIfRunning(request, row.id, ORCHESTRATION_SIGNALS.approvalResolved, {
          approvalId: approval.id,
          status,
        });
      } catch (err) {
        // The decision stands (the waiting tool reads it from the row); the signal only wakes the
        // workflow's picture of it.
        request.log.warn({ err }, 'approval decided but the workflow was not signalled');
      }
      await audit(request, row.id, 'approval', { approvalId: approval.id, status });
      return { data: { approvalId: approval.id, status } };
    }
  );

  // ── Cancel and end (launcher; an ADMIN also, for an orchestration no person launched) ──

  app.post(
    '/:id/cancel',
    {
      config: { serviceScopes: ['runs:agent'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: IdParams },
    },
    async (request, reply) => {
      const row = await controlOwned(request, reply, request.params.id, { emergencyStop: true });
      if (!row) {
        return reply;
      }
      // Status first: it revokes the orchestration token and stops further spawns.
      const { count } = await prisma.orchestration.updateMany({
        data: { endedAt: new Date(), status: 'CANCELLED' },
        where: { id: row.id, status: { in: [...ORCHESTRATION_LIVE_STATUSES] }, teamId: row.teamId },
      });
      if (count !== 1) {
        return refusal(reply, 409, 'ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
      }
      await closeLedger(request, row, 'CANCELLED');
      const first = await cancelLiveChildren(request, row.id);
      let orchestratorFailed = 0;
      try {
        await cancelRun(orchestrationWorkflowId(row.id));
      } catch (err) {
        orchestratorFailed = 1;
        request.log.error({ err }, 'orchestrator cancel failed');
      }
      // A second sweep: a spawn that was between its child row and its workflow start when the
      // first one ran has started by now (and cancels itself, see `afterStart`, if it did not
      // notice), and a child the first sweep could not reach is tried again. A child still
      // failing after the retry counts once, however many sweeps it failed in.
      const second = await cancelLiveChildren(request, row.id);
      const children = new Set([...first.ids, ...second.ids]);
      const failedChildren = new Set(second.failedIds);
      const failed = failedChildren.size + orchestratorFailed;
      await audit(request, row.id, 'cancel', {
        children: children.size,
        failed,
        scope: 'orchestration',
        ...stopContext(request, row),
      });
      return {
        data: {
          childrenCancelled: Math.max(0, children.size - failedChildren.size),
          failed,
          status: 'CANCELLED',
        },
      };
    }
  );

  app.post(
    '/:id/end',
    {
      config: { serviceScopes: ['runs:agent'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: IdParams },
    },
    async (request, reply) => {
      const row = await controlOwned(request, reply, request.params.id, { emergencyStop: true });
      if (!row) {
        return reply;
      }
      if (!ORCHESTRATION_LIVE_STATUSES.includes(row.status as never)) {
        return refusal(reply, 409, 'ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
      }
      // Children first, while the orchestration token is still valid: flipping the status revokes
      // it, and the worker's own cancel calls would then be refused with 401. A child whose cancel
      // fails is retried once; if any still fails the status is NOT flipped, because COMPLETED
      // revokes the token and the orchestrator could no longer cancel the survivors itself.
      const first = await cancelLiveChildren(request, row.id);
      const retry = first.failed > 0 ? await cancelLiveChildren(request, row.id) : first;
      const stuck = first.failed > 0 ? retry.failedIds : [];
      if (stuck.length > 0) {
        await audit(request, row.id, 'cancel', {
          children: new Set([...first.ids, ...retry.ids]).size,
          failed: stuck.length,
          scope: 'end',
          status: 'not ended',
          ...stopContext(request, row),
        });
        return refusal(
          reply,
          502,
          'CHILD_CANCEL_FAILED',
          `${stuck.length} child${stuck.length === 1 ? '' : 'ren'} could not be cancelled; the orchestration was not ended. Try again.`
        );
      }
      const { count } = await prisma.orchestration.updateMany({
        data: { endedAt: new Date(), status: 'COMPLETED' },
        where: { id: row.id, status: { in: [...ORCHESTRATION_LIVE_STATUSES] }, teamId: row.teamId },
      });
      if (count !== 1) {
        return refusal(reply, 409, 'ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended');
      }
      await closeLedger(request, row, 'COMPLETED');
      // A spawn that was between its child row and its workflow start is caught by this sweep or
      // by its own re-check after the start.
      const second = await cancelLiveChildren(request, row.id);
      try {
        await signalIfRunning(request, row.id, ORCHESTRATION_SIGNALS.cancel, { reason: 'ended' });
      } catch (err) {
        request.log.warn({ err }, 'the orchestration ended but its workflow was not signalled');
      }
      await audit(request, row.id, 'cancel', {
        children: new Set([...first.ids, ...retry.ids, ...second.ids]).size,
        failed: second.failed,
        scope: 'end',
        ...stopContext(request, row),
      });
      return { data: { status: 'COMPLETED' } };
    }
  );
};
