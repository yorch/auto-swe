/**
 * The guard against re-launching an unchanged request right after the template stopped it as
 * not actionable.
 *
 * `ticket-to-merge` ends a request validation cannot act on (a bare ticket link the gatherer
 * could not read, say) at its `terminateNotActionable` node, FAILED, before the implementer
 * spends a budget. Nothing about the request changes between that stop and an identical
 * re-launch, so the second run stops the same way. A launch whose request matches such a stop
 * is refused with `409 UNCHANGED_AFTER_NOT_ACTIONABLE` unless the caller says it knows
 * (`acknowledgeUnchanged: true`).
 */
import type { PrismaClient } from '@auto-swe/shared';
import type { FastifyReply } from 'fastify';
import { sendError } from './httpErrors.js';
import { buildWorkflowRunVisibilityFilter, type VisibilityActor } from './runVisibility.js';
import type { MaybeGate } from './tenantScope.js';

export const UNCHANGED_AFTER_NOT_ACTIONABLE = 'UNCHANGED_AFTER_NOT_ACTIONABLE';

/** How long after a not-actionable stop an identical request is refused. */
export const NOT_ACTIONABLE_RERUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many recent stops (and, separately, later runs) are compared. The lookup is bounded three
 * ways: it is skipped unless the template version can stop at all, the relational filters
 * (template, version, status, window, repository, ticket id) narrow rows before the JSON-path
 * ones run, and at most this many rows come back.
 */
const CANDIDATE_LIMIT = 25;

/** Whether a template version's spec can stop as not actionable, by `templateId:version`. A
 * version's spec never changes, so a verdict is kept for good; the map only needs a bound. */
const STOP_NODE_CACHE_LIMIT = 500;
const stopNodeCache = new Map<string, boolean>();

/** Forgets what is known about template versions (tests, which reuse ids across fixtures). */
export function clearStopNodeCache(): void {
  stopNodeCache.clear();
}

/** What makes two launches the same request. */
export interface RequestIdentity {
  description: string;
  /** The generic run input: it carries the repository (`connectionId`), budget and ticket. */
  payload: Record<string, unknown>;
  templateId: string;
  templateVersion: number;
}

const collapseWhitespace = (text: string) => text.trim().replace(/\s+/g, ' ');

/** Key order never changes a value's meaning, so it never changes its serialization. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)])
    );
  }
  return value;
}

/**
 * A stable string for a request's content. Whitespace in the description and the case of the
 * ticket id are not content; every other input is compared exactly.
 */
export function fingerprintRequest(description: string, payload: Record<string, unknown>): string {
  const normalised: Record<string, unknown> = { ...payload };
  if (typeof normalised.description === 'string') {
    normalised.description = collapseWhitespace(normalised.description);
  }
  if (typeof normalised.ticketId === 'string') {
    normalised.ticketId = normalised.ticketId.trim().toLowerCase();
  }
  return JSON.stringify(
    canonical({ description: collapseWhitespace(description), payload: normalised })
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface UnchangedRerunDeps {
  gate: MaybeGate;
  log: { warn: (obj: object, msg: string) => void };
  now?: () => number;
  prisma: Pick<PrismaClient, 'workflowRun' | 'workflowTemplateVersion'>;
  /** The launching person; a caller that is not one (a service principal) is not checked. */
  user: VisibilityActor | null;
}

/** The terminate node that ends a request validation cannot act on (`validatePhase`). */
const STOP_NODE_ID = 'terminateNotActionable';

async function versionCanStop(
  prisma: UnchangedRerunDeps['prisma'],
  identity: RequestIdentity
): Promise<boolean> {
  const key = `${identity.templateId}:${identity.templateVersion}`;
  const known = stopNodeCache.get(key);
  if (known !== undefined) {
    return known;
  }
  const version = await prisma.workflowTemplateVersion.findFirst({
    select: { spec: true },
    where: { templateId: identity.templateId, version: identity.templateVersion },
  });
  const nodes = isRecord(version?.spec) ? version.spec.nodes : null;
  const node = isRecord(nodes) ? nodes[STOP_NODE_ID] : null;
  const canStop = isRecord(node) && node.type === 'terminate';
  if (version) {
    if (stopNodeCache.size >= STOP_NODE_CACHE_LIMIT) {
      stopNodeCache.clear();
    }
    stopNodeCache.set(key, canStop);
  }
  return canStop;
}

/**
 * Sends the 409 and returns true when the request stopped as not actionable inside the window,
 * in a run the caller may see, and nothing has run it since. Returns false (nothing sent)
 * otherwise.
 *
 * A not-actionable stop is read from what the run recorded, never from its text: the run
 * FAILED, its spec holds the `terminateNotActionable` terminate node, and its context holds
 * validation's `actionable == false` verdict, which is the condition that routes there. Only
 * runs the caller may see are compared.
 *
 * Only the newest run of a request counts. A later run of the same request, or of the same work
 * request, whatever its outcome, means the stop was overridden or fixed, so the guard steps aside.
 *
 * A stop can come from something outside the request (a broken tracker token, an outage), which
 * clears when it is fixed. The guard does not look at why the earlier stop happened, so "Run
 * anyway" is the way past it.
 *
 * Best effort: a failed lookup is logged and the launch goes ahead.
 */
export async function refuseUnchangedRerun(
  deps: UnchangedRerunDeps,
  identity: RequestIdentity,
  reply: FastifyReply,
  acknowledged: boolean | undefined
): Promise<boolean> {
  if (acknowledged || !deps.user) {
    return false;
  }
  try {
    if (!(await versionCanStop(deps.prisma, identity))) {
      return false;
    }
    const since = new Date((deps.now?.() ?? Date.now()) - NOT_ACTIONABLE_RERUN_WINDOW_MS);
    const visible = buildWorkflowRunVisibilityFilter(deps.user, deps.gate);
    const ticketId =
      typeof identity.payload.ticketId === 'string' ? identity.payload.ticketId.trim() : '';
    const connectionId =
      typeof identity.payload.connectionId === 'string' ? identity.payload.connectionId : '';
    // Cheap relational narrowing, ahead of the JSON-path filters on the large snapshots.
    const sameRequest = {
      workRequest: {
        ...(connectionId ? { connectionId } : {}),
        ...(ticketId
          ? { externalTicketId: { equals: ticketId, mode: 'insensitive' as const } }
          : {}),
      },
    };
    const candidates = await deps.prisma.workflowRun.findMany({
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        workRequest: { select: { description: true, payload: true } },
        workRequestId: true,
      },
      take: CANDIDATE_LIMIT,
      where: {
        AND: [
          visible,
          {
            ...sameRequest,
            startedAt: { gte: since },
            status: 'FAILED',
            templateId: identity.templateId,
            templateVersion: identity.templateVersion,
          },
          {
            contextSnapshot: { equals: false, path: ['nodes', 'validate', 'output', 'actionable'] },
            specSnapshot: {
              equals: 'terminate',
              path: ['nodes', 'terminateNotActionable', 'type'],
            },
          },
        ],
      },
    });
    const wanted = fingerprintRequest(identity.description, identity.payload);
    const fingerprintOf = (run: {
      workRequest: { description: string; payload: unknown } | null;
    }) =>
      run.workRequest
        ? fingerprintRequest(
            run.workRequest.description,
            isRecord(run.workRequest.payload) ? run.workRequest.payload : {}
          )
        : null;
    const match = candidates.find((run) => fingerprintOf(run) === wanted);
    if (!match) {
      return false;
    }
    // Narrowed in the database to this work request, or to runs that submitted the same
    // description, so unrelated runs of the template cannot crowd the answer out of the cap. The
    // fingerprint below settles the rest.
    const descriptions = [
      ...new Set([identity.description, match.workRequest?.description ?? identity.description]),
    ];
    const later = await deps.prisma.workflowRun.findMany({
      orderBy: { startedAt: 'desc' },
      select: {
        workRequest: { select: { description: true, payload: true } },
        workRequestId: true,
      },
      take: CANDIDATE_LIMIT,
      where: {
        AND: [
          visible,
          {
            ...sameRequest,
            OR: [
              ...(match.workRequestId ? [{ workRequestId: match.workRequestId }] : []),
              { workRequest: { description: { in: descriptions } } },
            ],
            startedAt: { gt: match.startedAt },
            templateId: identity.templateId,
          },
        ],
      },
    });
    if (
      later.some(
        (run) =>
          (match.workRequestId !== null && run.workRequestId === match.workRequestId) ||
          fingerprintOf(run) === wanted
      )
    ) {
      return false;
    }
    sendError(
      reply,
      409,
      UNCHANGED_AFTER_NOT_ACTIONABLE,
      `The same request stopped before as not actionable (run ${match.id}, ${match.startedAt.toISOString()}). ` +
        'Change the request (add the ticket text or acceptance criteria), or ask a person to confirm launching it unchanged.',
      { previousRunId: match.id, stoppedAt: match.startedAt.toISOString() }
    );
    return true;
  } catch (err) {
    deps.log.warn({ err }, 'unchanged-rerun check failed; launching');
    return false;
  }
}
