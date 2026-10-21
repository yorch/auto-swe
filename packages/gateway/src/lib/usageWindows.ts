import type { PrismaClient } from '@auto-swe/shared';
import { DAY_MS, rollupHorizonMs } from '@auto-swe/shared/lib/agentTraceRollup';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

/** A half-open instant range, the shape of a Prisma `createdAt` filter. */
export interface Range {
  gte: Date;
  lt: Date;
}

/**
 * How a window of whole UTC days is read: the days with a usable rollup come from
 * `agent_trace_daily_usage`, everything else from the live `agent_traces`.
 */
export interface WindowPlan {
  /** Contiguous stretches of `agent_traces` to read, oldest first. */
  live: Range[];
  /** UTC midnights of the days to read from the rollup. */
  rollupDays: Date[];
}

/**
 * Splits `[startMs, endMs)` (both UTC midnights) into rollup days and live ranges. A day is read
 * from the rollup only when it lies strictly before `horizonMs` — older than the days every sweep
 * still rewrites — and `covered` says it has rollup rows. Every other day is live, so an absent
 * or lagging sweep changes how fast the report is, not what it says.
 */
export function planWindow(
  startMs: number,
  endMs: number,
  covered: ReadonlySet<number>,
  horizonMs: number
): WindowPlan {
  const live: Range[] = [];
  const rollupDays: Date[] = [];
  let open: number | null = null;
  const close = (at: number) => {
    if (open !== null) {
      live.push({ gte: new Date(open), lt: new Date(at) });
      open = null;
    }
  };
  for (let d = startMs; d < endMs; d += DAY_MS) {
    if (d < horizonMs && covered.has(d)) {
      close(d);
      rollupDays.push(new Date(d));
    } else if (open === null) {
      open = d;
    }
  }
  close(endMs);
  return { live, rollupDays };
}

/** The `createdAt` predicate for `ranges`: one range stays the plain filter the report always used. */
export function timeWhere(
  ranges: readonly Range[]
): { createdAt: Range } | { OR: { createdAt: Range }[] } {
  const [only] = ranges;
  return ranges.length === 1 && only
    ? { createdAt: only }
    : { OR: ranges.map((r) => ({ createdAt: r })) };
}

/** The parts of `ranges` inside `[startMs, endMs)`. */
export function clipRanges(ranges: readonly Range[], startMs: number, endMs: number): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const gte = Math.max(r.gte.getTime(), startMs);
    const lt = Math.min(r.lt.getTime(), endMs);
    if (gte < lt) {
      out.push({ gte: new Date(gte), lt: new Date(lt) });
    }
  }
  return out;
}

/**
 * The UTC days in `[startMs, endMs)` that have rollup rows, as epoch ms. Unscoped on purpose: it
 * reveals only which days the sweep has built, and a day is all-or-nothing, so a scope with no
 * spend on a built day correctly reads zero from the rollup instead of re-scanning the traces.
 */
export async function coveredRollupDays(
  prisma: Pick<PrismaClient, 'agentTraceDailyUsage'>,
  startMs: number,
  endMs: number,
  nowMs: number
): Promise<Set<number>> {
  const horizon = rollupHorizonMs(nowMs);
  if (startMs >= horizon) {
    return new Set();
  }
  const rows = await runUnscoped(
    'which UTC days the usage rollup has built, with no tenant data',
    ['AgentTraceDailyUsage'],
    () =>
      prisma.agentTraceDailyUsage.groupBy({
        by: ['day'],
        where: { day: { gte: new Date(startMs), lt: new Date(Math.min(endMs, horizon)) } },
      })
  );
  return new Set(rows.map((r) => r.day.getTime()));
}
