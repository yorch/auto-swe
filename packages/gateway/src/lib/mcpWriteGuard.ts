import { createHash } from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { resolveSettings } from '@auto-swe/shared/config';
import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '@auto-swe/shared/types/api';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type JwtPayload, requireUser } from '../plugins/auth.js';
import { writeAuditLog } from './auditLog.js';
import type { LaunchGuard } from './workflowLaunch.js';

/**
 * The guards on an MCP write, enforced in the REST route that serves it.
 *
 * They live here, called by `POST /work-requests` and `POST /workflow-runs/:id/cancel` whenever
 * the request is a bridged MCP call, and not in the tool, so a leaked bridge secret plus a valid
 * write token gets exactly what the tool gets and no more. A request that is not bridged (every
 * REST and CLI caller) passes straight through: nothing here changes how REST behaves.
 *
 * In order: writes enabled, the per-user burst limit, the budget tier, the idempotency key. The
 * concurrency cap cannot be checked here, because a check made before the insert is racy; it is
 * handed back as a `LaunchGuard`, which `launchTrackedWorkflow` runs inside the transaction that
 * writes the ledger rows.
 */

export type McpWriteTool = 'submit_work_request' | 'cancel_run';

/** Refusal codes the MCP tools translate to a fixed message. The codes are a closed vocabulary. */
export const MCP_WRITE_CODES = {
  disabled: 'MCP_WRITE_DISABLED',
  idempotencyKeyRequired: 'MCP_IDEMPOTENCY_KEY_REQUIRED',
  rateLimited: 'MCP_WRITE_RATE_LIMITED',
  runCapReached: 'MCP_RUN_CAP_REACHED',
  tierNotAllowed: 'MCP_BUDGET_TIER_NOT_ALLOWED',
} as const;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by {@link assertMcpWriteAllowed} on a bridged write; read by {@link mcpWriteAuditHook}. */
    mcpWrite?: { tool: McpWriteTool; inputDigest: string };
  }
}

const WINDOW_MS = 60_000;
const recentCalls = new Map<string, number[]>();

/**
 * Sliding one-minute window per user, in this process. Counts every attempt, refused or not, so a
 * misbehaving agent cannot keep probing for free. Per replica: documented, not coordinated.
 */
function overBurstLimit(userId: string, limit: number, now = Date.now()): boolean {
  const times = (recentCalls.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  const over = times.length >= limit;
  times.push(now);
  recentCalls.set(userId, times);
  if (recentCalls.size > 10_000) {
    for (const [id, ts] of recentCalls) {
      if (ts.every((t) => now - t >= WINDOW_MS)) {
        recentCalls.delete(id);
      }
    }
  }
  return over;
}

/** For tests: forget every user's recent calls. */
export function resetMcpWriteRateLimit() {
  recentCalls.clear();
}

const TERMINAL = [...ACTIVE_WORKFLOW_TERMINAL_STATUSES];

/**
 * The concurrency cap as a launch guard. Under a transaction-scoped advisory lock keyed by the
 * user, count the user's non-terminal `ActiveWorkflow` rows, whatever launched them. The lock is
 * held to the end of the transaction that then writes this launch's own rows, so the next
 * bridged launch of the same user counts after this one's rows are committed. `ActiveWorkflow` is
 * written synchronously at submit, unlike `WorkflowRun`, which the worker creates later.
 */
function runCapGuard(userId: string, cap: number): LaunchGuard {
  return async (tx: Prisma.TransactionClient) => {
    // CLAUDE.md §7 exception: Prisma cannot express a transaction-scoped advisory lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-launch:${userId}`}, 0))`;
    const inFlight = await tx.activeWorkflow.count({
      where: {
        currentStatus: { notIn: TERMINAL },
        workRequest: { requestedById: userId },
      },
    });
    return inFlight >= cap ? MCP_WRITE_CODES.runCapReached : null;
  };
}

export type McpWriteDecision =
  | { refused: FastifyReply }
  | {
      refused?: undefined;
      /** Pass to `launchTrackedWorkflow` as `guard`; absent when the request was not bridged. */
      launchGuard?: LaunchGuard;
    };

function refuse(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string
): McpWriteDecision {
  request.log.info({ code }, 'mcp: a write was refused by the route guard');
  return { refused: reply.status(status).send({ error: { code, message } }) };
}

/**
 * Run the write guards for a bridged call. Returns `{ refused }` with the reply already sent, or
 * the decision to proceed. Call it before anything else in the handler, and in particular before
 * the idempotency replay, so a refused write never reaches a replayed answer.
 */
export async function assertMcpWriteAllowed(
  request: FastifyRequest,
  reply: FastifyReply,
  call: {
    tool: McpWriteTool;
    /** What the call was asked to do; only a digest of it is kept. */
    input: unknown;
    /** `submit_work_request` only. */
    submit?: { budgetTier: string; idempotencyKey: string | undefined };
  }
): Promise<McpWriteDecision> {
  if (!request.mcpBridge) {
    return {};
  }
  const user = requireUser(request);
  request.mcpWrite = {
    inputDigest: createHash('sha256').update(JSON.stringify(call.input)).digest('hex'),
    tool: call.tool,
  };

  // Settings are read per call. If they cannot be read this throws and the call is a 500: a
  // guard that cannot tell what is allowed must not allow.
  const settings = await resolveSettings([
    'mcp.writeToolsEnabled',
    'mcp.writeCallsPerMinute',
    'mcp.maxConcurrentRuns',
  ]);
  if (!settings['mcp.writeToolsEnabled']) {
    return refuse(request, reply, 403, MCP_WRITE_CODES.disabled, 'MCP write access is not enabled');
  }
  if (overBurstLimit(user.sub, settings['mcp.writeCallsPerMinute'])) {
    return refuse(
      request,
      reply,
      429,
      MCP_WRITE_CODES.rateLimited,
      'Too many write calls; wait a minute'
    );
  }
  if (!call.submit) {
    return {};
  }
  if (call.submit.budgetTier !== 'STANDARD') {
    return refuse(
      request,
      reply,
      422,
      MCP_WRITE_CODES.tierNotAllowed,
      'MCP submissions run at the STANDARD budget tier'
    );
  }
  if (!call.submit.idempotencyKey) {
    return refuse(
      request,
      reply,
      422,
      MCP_WRITE_CODES.idempotencyKeyRequired,
      'An Idempotency-Key header is required'
    );
  }
  return { launchGuard: runCapGuard(user.sub, settings['mcp.maxConcurrentRuns']) };
}

/** Maps the cap guard's refusal to the reply the route sends. */
export function sendRunCapRefusal(reply: FastifyReply) {
  return reply.status(429).send({
    error: {
      code: MCP_WRITE_CODES.runCapReached,
      message: 'You already have the maximum number of runs in flight',
    },
  });
}

/**
 * Route-level `onSend` hook that writes the audit row for a bridged write: who (the user and the
 * consent they gave), through which client, which tool, a digest of the input, and how it ended.
 * One row per guarded attempt, refusals included. The input's text is never stored, only its
 * digest. Best-effort by design: an audit failure is logged and never changes the response, so a
 * run that launched is not reported to the agent as an error it would retry.
 */
export async function mcpWriteAuditHook(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
) {
  const write = request.mcpWrite;
  const bridge = request.mcpBridge;
  const user: JwtPayload | undefined = request.user;
  if (!write || !bridge || !user) {
    return payload;
  }
  try {
    let body: { data?: Record<string, unknown>; error?: { code?: unknown } } | undefined;
    try {
      body = typeof payload === 'string' ? JSON.parse(payload) : undefined;
    } catch {
      body = undefined;
    }
    const workflowIds = body?.data?.workflowIds;
    await writeAuditLog(request.server, {
      action: 'CREATE',
      actor: user,
      after: {
        errorCode: typeof body?.error?.code === 'string' ? body.error.code : undefined,
        inputDigest: write.inputDigest,
        oauthClientId: bridge.clientId,
        runId: write.tool === 'cancel_run' ? body?.data?.id : undefined,
        status: reply.statusCode,
        tool: write.tool,
        workflowIds: Array.isArray(workflowIds) ? workflowIds : undefined,
        workRequestId: body?.data?.workRequestId,
      },
      entityId: bridge.consentId,
      entityType: 'McpToolCall',
    });
  } catch (err) {
    request.log.error({ err, tool: write.tool }, 'mcp: could not write the audit row for a write');
  }
  return payload;
}
