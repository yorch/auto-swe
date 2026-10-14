/**
 * The run-callback delivery sweep (docs/run-callbacks.md): sends due
 * `OutboundDelivery` rows, signed, and records each outcome.
 *
 * A row is claimed with `FOR UPDATE SKIP LOCKED` in one statement that also
 * pushes its `nextAttemptAt` out by a lease and counts the attempt, so two
 * sweeps never send the same row at once and a sweep that dies mid-send leaves
 * the row to be retried when the lease lapses. The send happens outside any
 * transaction. The result is written only if the row is still the attempt this
 * sweep claimed (a redelivery in between resets `attempts`), so a stale result
 * never overwrites a fresh one.
 *
 * Delivery is at least once: a receiver that answers 2xx after the platform
 * gave up waiting gets the same delivery id again. Ordering is not guaranteed.
 */
import { prisma } from '@auto-swe/shared/db';
import {
  type CallbackDeadReason,
  callbackUrlMatchesEndpoint,
  endpointSigningSecrets,
  nextCallbackAttemptAt,
  openCallbackUrl,
  parseCallbackUrl,
} from '@auto-swe/shared/lib/runCallbacks';
import { checkProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { logWarn } from '../lib/activityLog.js';
import {
  type CallbackAttempt,
  type SendCallbackDeps,
  sendCallback,
} from '../lib/callbackSender.js';

/** Rows claimed per sweep; a larger backlog is finished by the following sweeps. */
export const CALLBACK_CLAIM_BATCH = 100;
/** How long a claimed row is held before another sweep may claim it again. */
export const CALLBACK_CLAIM_LEASE_MS = 5 * 60 * 1000;
/** Sends in flight at once. Each is bounded by the 10 s request timeout. */
const SEND_CONCURRENCY = 8;

export interface DeliverCallbacksResult {
  claimed: number;
  delivered: number;
  retrying: number;
  dead: number;
}

/** Test seams. */
export interface DeliverCallbacksDeps extends SendCallbackDeps {
  now?: () => Date;
  send?: typeof sendCallback;
}

interface Claimed {
  id: string;
  attempts: number;
}

/** Claim up to `limit` due rows: one statement, so the lock and the lease are taken together. */
export async function claimDueDeliveries(limit: number, leaseMs: number): Promise<Claimed[]> {
  // CLAUDE.md §7 exception: `FOR UPDATE SKIP LOCKED` lets concurrent sweeps claim disjoint
  // rows; Prisma has no API for it.
  return prisma.$queryRaw<Claimed[]>`
    UPDATE outbound_deliveries
    SET next_attempt_at = now() + ${Math.ceil(leaseMs / 1000)}::int * interval '1 second',
        attempts = attempts + 1,
        last_attempt_at = now()
    WHERE id IN (
      SELECT id FROM outbound_deliveries
      WHERE status = 'PENDING' AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT ${limit}::int
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, attempts
  `;
}

type Outcome = 'delivered' | 'retrying' | 'dead';

export async function deliverCallbacks(
  deps: DeliverCallbacksDeps = {}
): Promise<DeliverCallbacksResult> {
  const claimed = await claimDueDeliveries(CALLBACK_CLAIM_BATCH, CALLBACK_CLAIM_LEASE_MS);
  const result: DeliverCallbacksResult = {
    claimed: claimed.length,
    dead: 0,
    delivered: 0,
    retrying: 0,
  };
  let next = 0;
  const worker = async () => {
    while (next < claimed.length) {
      const row = claimed[next++] as Claimed;
      try {
        const outcome = await attemptDelivery(row, deps);
        if (outcome) {
          result[outcome] += 1;
        }
      } catch (err) {
        // A database error on one row leaves it claimed; the lease lapses and it is retried.
        logWarn('a run callback delivery could not be processed; it is retried after its lease', {
          deliveryId: row.id,
          err: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, claimed.length) }, worker));
  return result;
}

/** Send one claimed row and record what happened. Null when the row moved on meanwhile. */
export async function attemptDelivery(
  claimed: Claimed,
  deps: DeliverCallbacksDeps = {}
): Promise<Outcome | null> {
  const now = deps.now?.() ?? new Date();
  const row = await prisma.outboundDelivery.findUnique({
    select: {
      endpoint: {
        select: {
          allowPrivateNetwork: true,
          disabledAt: true,
          origin: true,
          pathPrefix: true,
          previousSigningSecretAuthTag: true,
          previousSigningSecretCiphertext: true,
          previousSigningSecretExpiresAt: true,
          previousSigningSecretKeyVersion: true,
          previousSigningSecretLastFour: true,
          previousSigningSecretNonce: true,
          signingSecretAuthTag: true,
          signingSecretCiphertext: true,
          signingSecretKeyVersion: true,
          signingSecretLastFour: true,
          signingSecretNonce: true,
        },
      },
      event: true,
      id: true,
      payload: true,
      retryWindowStartedAt: true,
      runCallback: {
        select: {
          target: true,
          urlAuthTag: true,
          urlCiphertext: true,
          urlKeyVersion: true,
          urlNonce: true,
        },
      },
      status: true,
    },
    where: { id: claimed.id },
  });
  if (row?.status !== 'PENDING') {
    return null;
  }
  const guard = { attempts: claimed.attempts, id: row.id, status: 'PENDING' as const };
  const dead = async (reason: CallbackDeadReason, attempt?: CallbackAttempt) => {
    const { count } = await prisma.outboundDelivery.updateMany({
      data: {
        deadAt: now,
        deadReason: reason,
        status: 'DEAD',
        ...(attempt && !attempt.ok
          ? { lastError: attempt.error, lastStatusCode: attempt.statusCode }
          : {}),
      },
      where: guard,
    });
    if (count > 0) {
      // Origin and path only: the query may carry the receiver's token.
      logWarn('run callback delivery is dead', {
        deliveryId: row.id,
        reason,
        target: row.runCallback?.target ?? null,
      });
    }
    return count > 0 ? ('dead' as const) : null;
  };

  const endpoint = row.endpoint;
  if (!endpoint) {
    return dead('ENDPOINT_DELETED');
  }
  if (endpoint.disabledAt) {
    return dead('ENDPOINT_DISABLED');
  }
  if (!row.runCallback) {
    return dead('CALLBACK_GONE');
  }
  let url: string;
  let secrets: string[];
  try {
    url = openCallbackUrl(row.runCallback);
  } catch {
    return dead('URL_UNREADABLE');
  }
  try {
    secrets = endpointSigningSecrets(endpoint, now);
  } catch {
    return dead('SECRET_UNREADABLE');
  }
  // The endpoint may have been edited since the launch named this URL; it must still be under
  // it, and the origin must still pass the text guard with the endpoint's current opt-in.
  const parsed = parseCallbackUrl(url);
  if (!parsed.ok || !callbackUrlMatchesEndpoint(parsed.value, endpoint)) {
    return dead('ENDPOINT_CHANGED');
  }
  if (!checkProbeUrl(endpoint.origin, { allowPrivate: endpoint.allowPrivateNetwork }).ok) {
    return dead('ENDPOINT_CHANGED');
  }

  const send = deps.send ?? sendCallback;
  const attempt = await send(
    {
      allowPrivateNetwork: endpoint.allowPrivateNetwork,
      body: JSON.stringify(row.payload),
      deliveryId: row.id,
      event: row.event,
      nowSec: Math.floor(now.getTime() / 1000),
      secrets,
      url,
    },
    deps
  );
  const finishedAt = deps.now?.() ?? new Date();
  if (attempt.ok) {
    const { count } = await prisma.outboundDelivery.updateMany({
      data: {
        deliveredAt: finishedAt,
        lastError: null,
        lastStatusCode: attempt.statusCode,
        status: 'DELIVERED',
      },
      where: guard,
    });
    return count > 0 ? 'delivered' : null;
  }
  const retryAt = nextCallbackAttemptAt(claimed.attempts, row.retryWindowStartedAt, finishedAt);
  if (!retryAt) {
    return dead('RETRIES_EXHAUSTED', attempt);
  }
  const { count } = await prisma.outboundDelivery.updateMany({
    data: { lastError: attempt.error, lastStatusCode: attempt.statusCode, nextAttemptAt: retryAt },
    where: guard,
  });
  return count > 0 ? 'retrying' : null;
}
