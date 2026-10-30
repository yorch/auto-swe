import type { Prisma, PrismaClient } from '../index.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * UTC days (as epoch ms) the daily rollup sweep has built at `bucketVersion` inside
 * `[gte, lt)`. A day with no runs writes no rollup rows, so row existence cannot say whether it
 * was built; the `RollupBuiltDay` marker, written in the same transaction as the day's rows, can.
 */
export async function builtRollupDays(
  db: Pick<PrismaClient, 'rollupBuiltDay'>,
  window: { gte: Date; lt: Date },
  bucketVersion: number
): Promise<Set<number>> {
  const rows = await runUnscoped(
    'which UTC days the rollup sweep has built, without exposing tenant data',
    ['RollupBuiltDay'],
    () =>
      db.rollupBuiltDay.findMany({
        select: { day: true },
        where: { bucketVersion, day: { gte: window.gte, lt: window.lt } },
      })
  );
  return new Set(rows.map((row) => row.day.getTime()));
}

/** Record, inside the day's rebuild transaction, that `day` is built (with or without rows). */
export async function markRollupDayBuilt(
  tx: Pick<Prisma.TransactionClient, 'rollupBuiltDay'>,
  day: Date,
  bucketVersion: number,
  builtAt: Date
): Promise<void> {
  await tx.rollupBuiltDay.upsert({
    create: { bucketVersion, builtAt, day },
    update: { builtAt },
    where: { day_bucketVersion: { bucketVersion, day } },
  });
}
