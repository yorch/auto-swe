/**
 * The usage rollup sweep (runs on the `AGENT_TRACE_ROLLUP_*` schedule): rewrites the rollup of the
 * last two completed UTC days — late traces land in them — and, when
 * `AGENT_TRACE_ROLLUP_BACKFILL_DAYS` asks for it, builds rollups for older days that have none.
 *
 * Idempotent: each day is deleted and rebuilt in one transaction (`rollupUsageDay`). A day that
 * already has rollup rows is never rebuilt by the backfill, so leaving the variable set costs one
 * cheap existence query per sweep, not a re-scan of history.
 *
 * `AgentTrace` and `AgentTraceDailyUsage` are tenant-scoped; the unscoped reads here are the
 * deployment-wide sweep's own, hence `runUnscoped`.
 */

import { prisma } from '@auto-swe/shared/db';
import {
  DAY_MS,
  ROLLUP_RECOMPUTE_DAYS,
  rollupUsageDay,
  utcDayStartMs,
} from '@auto-swe/shared/lib/agentTraceRollup';
import {
  resolveScheduledSweeps,
  validateScheduledSweepsEnv,
} from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { heartbeat } from '@temporalio/activity';
import { logWarn } from '../lib/activityLog.js';

/**
 * Backfilled days per sweep, so one run stays inside its activity timeout; the next continues.
 * The workflow's `startToCloseTimeout` (90 minutes) exceeds the two recomputed days plus this
 * many at the transaction's worst case (`TX_TIMEOUT_MS`, 12 x 5 minutes = 60), and its heartbeat timeout exceeds one transaction.
 */
export const MAX_BACKFILL_DAYS_PER_SWEEP = 10;

export interface RollupAgentTraceUsageResult {
  /** `YYYY-MM-DD` of every day rebuilt, newest first. */
  days: string[];
  /** Rollup rows written across those days. */
  rows: number;
  /** Days rebuilt for lack of any rollup (the backfill), a subset of `days`. */
  backfilled: number;
  /** True when the backfill stopped at its per-sweep limit with older missing days left. */
  more: boolean;
}

export async function rollupAgentTraceUsage(
  now: Date = new Date()
): Promise<RollupAgentTraceUsageResult> {
  const today = utcDayStartMs(now.getTime());
  const days: number[] = [];
  for (let i = 1; i <= ROLLUP_RECOMPUTE_DAYS; i++) {
    days.push(today - i * DAY_MS);
  }

  // Backfill: the days before those, back to the configured depth or the oldest trace, that have
  // no rollup rows. A day with no LLM calls has none either, so it is revisited (cheaply) each sweep.
  // The resolver quietly falls back to 0 on a bad value; a worker that is asked to backfill and
  // does not should say so.
  const badBackfill = validateScheduledSweepsEnv().filter((p) =>
    p.startsWith('AGENT_TRACE_ROLLUP_BACKFILL_DAYS')
  );
  if (badBackfill.length > 0) {
    logWarn('usage rollup backfill disabled: invalid AGENT_TRACE_ROLLUP_BACKFILL_DAYS', {
      problem: badBackfill.join('; '),
    });
  }
  const depth = resolveScheduledSweeps().agentTraceRollup.backfillDays;
  let backfilled = 0;
  let more = false;
  if (depth > 0) {
    const newest = today - (ROLLUP_RECOMPUTE_DAYS + 1) * DAY_MS;
    const configuredOldest = today - depth * DAY_MS;
    const oldestTrace = await runUnscoped(
      'the usage rollup backfill finds the oldest LLM trace',
      ['AgentTrace'],
      () =>
        prisma.agentTrace.aggregate({
          _min: { createdAt: true },
          where: { type: 'llm_response' },
        })
    );
    const oldest = oldestTrace._min.createdAt
      ? Math.max(configuredOldest, utcDayStartMs(oldestTrace._min.createdAt.getTime()))
      : null;
    if (oldest !== null && oldest <= newest) {
      const present = await runUnscoped(
        'the usage rollup backfill lists which days already have a rollup',
        ['AgentTraceDailyUsage'],
        () =>
          prisma.agentTraceDailyUsage.groupBy({
            by: ['day'],
            where: { day: { gte: new Date(oldest), lte: new Date(newest) } },
          })
      );
      const have = new Set(present.map((r) => r.day.getTime()));
      for (let d = newest; d >= oldest; d -= DAY_MS) {
        if (have.has(d)) {
          continue;
        }
        if (backfilled === MAX_BACKFILL_DAYS_PER_SWEEP) {
          more = true;
          break;
        }
        days.push(d);
        backfilled += 1;
      }
    }
  }

  let rows = 0;
  const done: string[] = [];
  for (const day of days) {
    // A day's transaction can run for minutes; a heartbeat between days is how Temporal tells a
    // slow sweep from a dead worker (and how a cancellation reaches it).
    heartbeat(`rolling up ${new Date(day).toISOString().slice(0, 10)}`);
    const result = await rollupUsageDay(prisma, day);
    rows += result.rows;
    done.push(result.day);
  }
  if (more) {
    logWarn('usage rollup backfill stopped at its per-sweep limit; the next sweep continues', {
      backfilled,
    });
  }
  return { backfilled, days: done, more, rows };
}
