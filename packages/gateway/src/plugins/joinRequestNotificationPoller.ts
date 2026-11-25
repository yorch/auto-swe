import type { PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { mergeReached, outcomeAfterFailure } from '@auto-swe/shared/lib/teamJoinRequests';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  type DeliveryDeps,
  type DeliveryOutcome,
  deliverJoinRequestNotification,
  type OutboxRow,
} from '../lib/joinRequestNotifier.js';

/**
 * Drains the join-request notification outbox (docs/specs/2026-11-24-team-join-requests-hardening.md §5).
 *
 * Each tick claims due `PENDING` rows with `FOR UPDATE SKIP LOCKED` in a short transaction that
 * also pushes their `nextAttemptAt` out by a lease, so several gateway replicas never take the same
 * row and a row whose claimer crashed comes back when the lease ends. Delivery runs outside that
 * transaction.
 *
 * The lease is a value the claimer holds: the `nextAttemptAt` it last wrote. Before a row is
 * delivered, and again before each recipient, the claimer extends it from now (a conditional update
 * on the value it holds), so a slow batch cannot let the lease of a row it has not reached lapse,
 * and a slow recipient cannot let it lapse under the ones after. If the update finds the value
 * changed (another poller re-claimed the row, an admin retried it, a purge removed it) the lease is
 * lost: nothing further is sent, and nothing is recorded, because every write of this tick's
 * results (`reached`, the outcome) carries the same condition. Only a row still `PENDING` with the
 * claimer's lease value is written. Delivered, skipped and failed rows past the retention period
 * are deleted, a bounded batch at most once a minute.
 *
 * A row's `reached` only ever grows. The poller keeps the latest set it knows was sent (what
 * `persistReached` was handed) and merges it into every outcome it writes, including the one for a
 * delivery that threw, so a database error between two recipients cannot erase the ones already
 * emailed.
 *
 * Stopping: once the poller is told to stop, no new row and no new recipient is started. The rows
 * of the batch that were not started are released (due at once, lease value checked), and a row
 * stopped between two recipients goes back with what it reached recorded and no failed attempt
 * counted. A send already under way gets `STOP_ABORT_GRACE_MS` to finish; after that it is aborted
 * (the email socket is destroyed, no fallback starts) and the row is handed back the same way:
 * due at once, the recipients already reached recorded, no failed attempt counted. The aborted
 * recipient's outcome is unknown, so it is not recorded and is sent again, which can duplicate it
 * if the relay had already accepted the message (at least once, never a recipient lost).
 */

/** Wait between ticks. */
export const POLL_INTERVAL_MS = 5_000;
/** Wait after boot before the first tick. */
export const FIRST_TICK_DELAY_MS = 5_000;
/** Rows one tick claims. */
export const CLAIM_BATCH_SIZE = 20;
/**
 * How long a claimed row stays out of reach of other pollers, counted from the last time the
 * claimer extended it. It is extended before the row and before each recipient, so it need only
 * outlast ONE send: an email is capped at `NOTIFICATION_SEND_DEADLINE_MS` (90 s) and a Slack post
 * at its own timeout. A claimer that dies is back in play when its last extension ends.
 */
export const CLAIM_LEASE_MS = 10 * 60_000;
/** Rows one purge deletes for retention. */
export const PURGE_BATCH_SIZE = 500;
/** The least time between two retention purges of one poller. */
export const PURGE_INTERVAL_MS = 60_000;
/** Longest a closing server waits for a tick that is running. */
export const STOP_WAIT_MS = 30_000;
/**
 * How long a closing poller lets a send that is under way finish before aborting it. Most sends
 * take well under a second, so the grace spares them a duplicate; it is far below `STOP_WAIT_MS`,
 * so the aborted row is written back before the server gives up waiting and closes the database.
 */
export const STOP_ABORT_GRACE_MS = 5_000;

export interface RunOnceOptions extends DeliveryDeps {
  now?: () => Date;
  batchSize?: number;
  leaseMs?: number;
  /** True once the poller is stopping (see the file comment). */
  shouldStop?: () => boolean;
  /** Aborts a send under way once the stop grace has passed (see the file comment). */
  signal?: AbortSignal;
  /** Replaces the delivery function. Tests only. */
  deliver?: (row: OutboxRow, deps: DeliveryDeps) => Promise<DeliveryOutcome>;
  /** False skips the retention purge. */
  purge?: boolean;
  log?: Pick<FastifyBaseLogger, 'error' | 'warn'>;
}

export interface RunOnceResult {
  claimed: number;
  delivered: number;
  skipped: number;
  /** Failed attempts, whether the row will retry or is now `FAILED`. */
  failed: number;
  purged: number;
  /** Rows handed back to the queue unsent or part-sent because the poller was stopping. */
  released: number;
  /** Rows whose lease another poller (or an admin) took over; nothing of theirs was recorded. */
  leaseLost: number;
}

/** A claimed row and the lease value this poller holds on it. */
export type ClaimedRow = OutboxRow & { leaseUntil: Date };

/**
 * Claims up to `batchSize` due rows. The returned rows are leased: their `nextAttemptAt` is now
 * `now + leaseMs`.
 */
export async function claimDueNotifications(
  prisma: PrismaClient,
  now: Date,
  batchSize: number,
  leaseMs: number
): Promise<ClaimedRow[]> {
  return prisma.$transaction(async (tx) => {
    // CLAUDE.md §7 exception: Prisma has no SKIP LOCKED. Replicas that tick together must each
    // claim different rows, and a row another transaction holds is passed over, not waited for.
    const due = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id
      FROM join_request_notifications
      WHERE status = 'PENDING' AND next_attempt_at <= ${now.toISOString()}::timestamptz
      ORDER BY next_attempt_at ASC, id ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED`;
    if (due.length === 0) {
      return [];
    }
    const ids = due.map((r) => r.id);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    await tx.joinRequestNotification.updateMany({
      data: { nextAttemptAt: leaseUntil },
      where: { id: { in: ids } },
    });
    const rows = await tx.joinRequestNotification.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        attempts: true,
        audience: true,
        event: true,
        id: true,
        reached: true,
        requestId: true,
      },
      where: { id: { in: ids } },
    });
    return rows.map((row) => ({ ...row, leaseUntil }));
  });
}

/**
 * Writes an outcome only if this poller still holds the row: `PENDING` and `nextAttemptAt` equal to
 * the lease value it last wrote. An admin retry, a purge, or another poller's re-claim changes one
 * of the two, and the late outcome is dropped instead of overwriting theirs. Returns whether the
 * row was written.
 */
async function recordOutcome(
  prisma: PrismaClient,
  row: OutboxRow,
  lease: Date,
  outcome: Exclude<DeliveryOutcome, { kind: 'lease_lost' }>,
  now: Date
): Promise<boolean> {
  const where = { id: row.id, nextAttemptAt: lease, status: 'PENDING' as const };
  if (outcome.kind === 'interrupted') {
    // Due at once, attempts untouched: stopping is not the row's failure.
    return (
      (
        await prisma.joinRequestNotification.updateMany({
          data: { nextAttemptAt: now, reached: outcome.reached },
          where,
        })
      ).count === 1
    );
  }
  if (outcome.kind === 'delivered') {
    return (
      (
        await prisma.joinRequestNotification.updateMany({
          data: {
            deliveredAt: now,
            lastError: null,
            reached: outcome.reached,
            status: 'DELIVERED',
          },
          where,
        })
      ).count === 1
    );
  }
  if (outcome.kind === 'skipped') {
    return (
      (
        await prisma.joinRequestNotification.updateMany({
          data: { lastError: outcome.code, reached: outcome.reached, status: 'SKIPPED' },
          where,
        })
      ).count === 1
    );
  }
  const next = outcomeAfterFailure(row.attempts, now);
  const { count } = await prisma.joinRequestNotification.updateMany({
    data: {
      attempts: next.attempts,
      lastError: outcome.code,
      nextAttemptAt: next.nextAttemptAt ?? now,
      reached: outcome.reached,
      status: next.status,
    },
    where,
  });
  return count === 1;
}

/**
 * Hands a claimed row that was never started back: due now, only if this poller still holds it
 * (`PENDING` with its lease value). A row whose lease was lost belongs to whoever took it and is
 * left alone.
 */
async function releaseUnstarted(
  prisma: PrismaClient,
  row: ClaimedRow,
  now: Date,
  log: RunOnceOptions['log']
): Promise<boolean> {
  try {
    const { count } = await prisma.joinRequestNotification.updateMany({
      data: { nextAttemptAt: now },
      where: { id: row.id, nextAttemptAt: row.leaseUntil, status: 'PENDING' },
    });
    return count === 1;
  } catch (err) {
    // The lease ends on its own; a failed release only delays the row.
    log?.error({ errorName: (err as Error)?.name }, 'join-request notification release failed');
    return false;
  }
}

/** Deletes delivered, skipped and failed rows older than the retention period. */
export async function purgeOldNotifications(prisma: PrismaClient, now: Date): Promise<number> {
  const days = await resolveSetting('teams.joinRequestNotificationRetentionDays');
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const old = await prisma.joinRequestNotification.findMany({
    orderBy: { updatedAt: 'asc' },
    select: { id: true },
    take: PURGE_BATCH_SIZE,
    where: { status: { in: ['DELIVERED', 'SKIPPED', 'FAILED'] }, updatedAt: { lt: cutoff } },
  });
  if (old.length === 0) {
    return 0;
  }
  const { count } = await prisma.joinRequestNotification.deleteMany({
    where: {
      id: { in: old.map((r) => r.id) },
      status: { in: ['DELIVERED', 'SKIPPED', 'FAILED'] },
    },
  });
  return count;
}

/** One tick: claim, deliver, record, purge. Exported for tests. */
export async function runOnce(
  prisma: PrismaClient,
  options: RunOnceOptions = {}
): Promise<RunOnceResult> {
  const clock = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? CLAIM_LEASE_MS;
  const result: RunOnceResult = {
    claimed: 0,
    delivered: 0,
    failed: 0,
    leaseLost: 0,
    purged: 0,
    released: 0,
    skipped: 0,
  };
  const rows = await claimDueNotifications(
    prisma,
    clock(),
    options.batchSize ?? CLAIM_BATCH_SIZE,
    leaseMs
  );
  result.claimed = rows.length;
  const deliver =
    options.deliver ??
    ((row: OutboxRow, deps: DeliveryDeps) => deliverJoinRequestNotification(prisma, row, deps));
  for (const [index, row] of rows.entries()) {
    if (options.shouldStop?.()) {
      // Stopping: this row and every row after it were claimed and never started.
      for (const unstarted of rows.slice(index)) {
        if (await releaseUnstarted(prisma, unstarted, clock(), options.log)) {
          result.released += 1;
        } else {
          result.leaseLost += 1;
        }
      }
      break;
    }
    // The lease value this poller holds on the row; every write below is conditional on it.
    let lease = row.leaseUntil;
    // The recipients known to have been sent, ever growing; see the file comment.
    let knownReached = mergeReached(row.reached, []);
    const renewLease = async (): Promise<boolean> => {
      const next = new Date(clock().getTime() + leaseMs);
      const { count } = await prisma.joinRequestNotification.updateMany({
        data: { nextAttemptAt: next },
        where: { id: row.id, nextAttemptAt: lease, status: 'PENDING' },
      });
      if (count === 1) {
        lease = next;
      }
      return count === 1;
    };
    // A row later in a batch may have waited long: extend it from now, or give it up unsent.
    if (!(await renewLease())) {
      result.leaseLost += 1;
      continue;
    }
    let outcome: DeliveryOutcome;
    try {
      outcome = await deliver(row, {
        persistReached: async (reached) => {
          // Remember them BEFORE the write: they were sent whether or not the write succeeds, and
          // the outcome of a delivery that throws here still records them.
          knownReached = mergeReached(knownReached, reached);
          await prisma.joinRequestNotification.updateMany({
            data: { reached },
            where: { id: row.id, nextAttemptAt: lease, status: 'PENDING' },
          });
        },
        renewLease,
        ...(options.shouldStop ? { shouldStop: options.shouldStop } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.emailDeadlineMs === undefined
          ? {}
          : { emailDeadlineMs: options.emailDeadlineMs }),
        ...(options.slackApiBase ? { slackApiBase: options.slackApiBase } : {}),
      });
    } catch (err) {
      // An unexpected error (the database, a bug) is a failed attempt with the generic code; its
      // text can name an address, so it is logged by type only.
      options.log?.error({ errorName: (err as Error)?.name }, 'join-request notification failed');
      // Not `row.reached`, which is the value read at claim: recipients sent since then must stay
      // recorded, or the retry emails them again.
      outcome = { code: 'transport_error', kind: 'failed', reached: knownReached };
    }
    if (outcome.kind !== 'lease_lost') {
      // Whatever the delivery reports, a recipient known to be reached never drops out.
      outcome = { ...outcome, reached: mergeReached(knownReached, outcome.reached) };
    }
    if (
      outcome.kind === 'lease_lost' ||
      !(await recordOutcome(prisma, row, lease, outcome, clock()))
    ) {
      // Another poller or an admin owns the row now; whatever they record stands.
      result.leaseLost += 1;
      continue;
    }
    if (outcome.kind === 'interrupted') {
      result.released += 1;
    } else if (outcome.kind === 'delivered') {
      result.delivered += 1;
    } else if (outcome.kind === 'skipped') {
      result.skipped += 1;
    } else {
      result.failed += 1;
    }
  }
  if (options.purge !== false && !options.shouldStop?.()) {
    try {
      result.purged = await purgeOldNotifications(prisma, clock());
    } catch (err) {
      options.log?.error({ errorName: (err as Error)?.name }, 'join-request purge failed');
    }
  }
  return result;
}

export interface Poller {
  start(): void;
  /** Stops scheduling; resolves when the tick that is running, if any, has ended. */
  stop(): Promise<void>;
}

/** A self-rescheduling timer: the next wait starts when a tick ends, so ticks never overlap. */
export function createNotificationPoller(opts: {
  /** `stopping` turns true once `stop()` was called, so a long tick can wind down. */
  tick: (stopping: () => boolean, signal: AbortSignal) => Promise<RunOnceResult>;
  /** Replaces `STOP_ABORT_GRACE_MS`. Tests only. */
  abortGraceMs?: number;
  intervalMs: number;
  firstDelayMs: number;
  batchSize: number;
  log: Pick<FastifyBaseLogger, 'error'>;
}): Poller {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<void> | undefined;
  const abortController = new AbortController();

  const schedule = (ms: number) => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      running = run().finally(() => {
        running = undefined;
      });
    }, ms);
  };

  const run = async () => {
    let more = false;
    try {
      const result = await opts.tick(() => stopped, abortController.signal);
      // A full batch means more may be due: go on at once instead of waiting a whole interval.
      more = result.claimed >= opts.batchSize;
    } catch (err) {
      opts.log.error(
        { errorName: (err as Error)?.name },
        'a join-request notification tick failed'
      );
    }
    schedule(more ? 0 : opts.intervalMs);
  };

  return {
    start: () => schedule(opts.firstDelayMs),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      const inFlight = running;
      if (!inFlight) {
        return Promise.resolve();
      }
      // A tick is running: give a send under way the grace to finish, then abort it.
      const abortTimer = setTimeout(
        () => abortController.abort(),
        opts.abortGraceMs ?? STOP_ABORT_GRACE_MS
      );
      return inFlight.finally(() => clearTimeout(abortTimer));
    },
  };
}

export interface JoinRequestNotificationPollerOptions {
  /** Tests only. */
  intervalMs?: number;
  firstDelayMs?: number;
}

export function startJoinRequestNotificationPoller(
  fastify: FastifyInstance,
  opts: JoinRequestNotificationPollerOptions = {}
): Poller {
  const batchSize = CLAIM_BATCH_SIZE;
  // The purge scans by status and age, so it runs at most once a minute, not on every 5 s tick.
  let lastPurgeAt = 0;
  return createNotificationPoller({
    batchSize,
    firstDelayMs: opts.firstDelayMs ?? FIRST_TICK_DELAY_MS,
    intervalMs: opts.intervalMs ?? POLL_INTERVAL_MS,
    log: fastify.log,
    tick: (stopping, signal) => {
      const due = Date.now() - lastPurgeAt >= PURGE_INTERVAL_MS;
      if (due) {
        lastPurgeAt = Date.now();
      }
      return runOnce(fastify.prisma, {
        batchSize,
        log: fastify.log,
        purge: due,
        shouldStop: stopping,
        signal,
      });
    },
  });
}

export default fp<JoinRequestNotificationPollerOptions>(
  async (fastify, opts) => {
    const poller = startJoinRequestNotificationPoller(fastify, opts);
    poller.start();
    fastify.addHook('onClose', async () => {
      // The database plugin closes after this hook, so a running tick is waited for, up to a bound.
      let timer: NodeJS.Timeout | undefined;
      const gaveUp = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      });
      await Promise.race([poller.stop(), gaveUp]);
      clearTimeout(timer);
    });
  },
  { dependencies: ['prisma'], fastify: '5.x', name: 'join-request-notification-poller' }
);
