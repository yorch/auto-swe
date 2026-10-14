import { randomUUID } from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { pullRequestUrl } from '@auto-swe/shared/lib/pullRequest';
import {
  buildCallbackPayload,
  type CallbackEventType,
  callbackDedupeKey,
} from '@auto-swe/shared/lib/runCallbacks';
import { resolveGitHubBaseUrl, resolveWebUrl } from '@auto-swe/shared/lib/systemConfig';
import { logWarn } from './activityLog.js';

/**
 * The run-callback outbox (docs/run-callbacks.md): the rows the delivery sweep
 * sends. A row is written in the SAME transaction as the event it reports —
 * the run's guarded terminal write, a human step's creation — so the event is
 * recorded exactly when it happens, once, and never by workflow code (which
 * replays). Reading what goes into the row happens before that transaction;
 * only the insert is inside it.
 */

/** A run's callback, when it has one that this execution reports to. */
export interface RunCallbackTarget {
  runCallbackId: string;
  endpointId: string;
  events: string[];
  context: unknown;
}

/**
 * The callback the run's request asked for, if it applies to this execution:
 * the request has one, it names this workflow id (a re-run reuses the request
 * and does not report), and its endpoint still exists and subscribes to `event`.
 * A disabled endpoint still gets the row; the sweep marks it DEAD with a reason
 * an endpoint manager can see, and redeliver once it is enabled again.
 */
export async function runCallbackFor(
  workRequestId: string | null | undefined,
  workflowId: string | null | undefined,
  event: CallbackEventType
): Promise<RunCallbackTarget | null> {
  if (!workRequestId || !workflowId) {
    return null;
  }
  const callback = await prisma.runCallback.findUnique({
    select: {
      context: true,
      endpoint: { select: { events: true, id: true } },
      id: true,
      workflowId: true,
    },
    where: { runInputId: workRequestId },
  });
  if (!callback || callback.workflowId !== workflowId || !callback.endpoint) {
    return null;
  }
  if (!callback.endpoint.events.includes(event)) {
    return null;
  }
  return {
    context: callback.context,
    endpointId: callback.endpoint.id,
    events: callback.endpoint.events,
    runCallbackId: callback.id,
  };
}

/**
 * The pull request this run opened, as a link. Best-effort: a payload without
 * it is still worth sending, so a failure here is logged, not thrown.
 */
export async function runPullRequestUrl(workflowId: string): Promise<string | null> {
  try {
    const pr = await prisma.pullRequest.findFirst({
      orderBy: { openedAt: 'desc' },
      select: {
        prNumber: true,
        repository: { select: { githubUrl: true, organizationName: true, repoName: true } },
      },
      where: { workflow: { temporalWorkflowId: workflowId } },
    });
    if (!pr?.repository) {
      return null;
    }
    return pullRequestUrl(pr.repository, pr.prNumber, await resolveGitHubBaseUrl());
  } catch (err) {
    logWarn('could not resolve the pull request link for a run callback', {
      err: err instanceof Error ? err.name : 'unknown',
      workflowId,
    });
    return null;
  }
}

export interface CallbackDeliveryInput {
  target: RunCallbackTarget;
  type: CallbackEventType;
  run: {
    id: string;
    workflowId: string;
    workRequestId: string | null;
    status: string;
    startedAt: Date;
    endedAt: Date | null;
    costUsd: number;
    pullRequestUrl?: string | null;
  };
  humanStep?: { id: string; kind: string };
  now?: Date;
}

/** The outbox row for one event. Its id is the payload's `id` and the `X-AutoSwe-Delivery` header. */
export function callbackDeliveryRow(
  input: CallbackDeliveryInput
): Prisma.OutboundDeliveryCreateManyInput {
  const id = randomUUID();
  const now = input.now ?? new Date();
  const payload = buildCallbackPayload({
    context: input.target.context,
    createdAt: now,
    deliveryId: id,
    ...(input.humanStep ? { humanStep: input.humanStep } : {}),
    run: input.run,
    type: input.type,
    webUrl: resolveWebUrl(),
  });
  return {
    createdAt: now,
    dedupeKey: callbackDedupeKey(input.run.id, input.type, input.humanStep?.id),
    endpointId: input.target.endpointId,
    event: input.type,
    id,
    nextAttemptAt: now,
    payload: payload as unknown as Prisma.InputJsonValue,
    retryWindowStartedAt: now,
    runCallbackId: input.target.runCallbackId,
    workflowRunId: input.run.id,
  };
}

/**
 * Insert the row inside the caller's transaction. `skipDuplicates` (ON CONFLICT
 * DO NOTHING on the dedupe key) rather than a plain insert: the transaction's
 * own guard is what makes the event exactly-once, and a conflict here must not
 * abort — and so undo — the write it accompanies.
 */
export async function insertCallbackDelivery(
  tx: Prisma.TransactionClient,
  row: Prisma.OutboundDeliveryCreateManyInput
): Promise<void> {
  await tx.outboundDelivery.createMany({ data: [row], skipDuplicates: true });
}
