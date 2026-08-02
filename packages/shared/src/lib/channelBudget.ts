import type { prisma as sharedPrisma } from '../db.js';

/**
 * The slice of the client this needs. Taken as a parameter rather than reaching
 * for the singleton so the gateway can pass `fastify.prisma` — which is the same
 * guarded singleton in production, but a decorated mock under `app.inject()`.
 */
type BudgetClient = Pick<
  typeof sharedPrisma,
  '$transaction' | 'channelBudgetHold' | 'channelMonthlyUsage'
>;

/**
 * Releasing a `ChannelBudgetHold` — the one refund protocol, shared by the
 * worker's TTL sweep and the gateway's admin reset.
 *
 * Both sides had their own copy, and they had already diverged: one decremented
 * against the hold's own `yearMonth`, the other against the current month, so a
 * hold that outlived a UTC month boundary was refunded from the wrong row. This
 * is a data-model invariant, not route logic — a bug here credits real spend
 * back and quietly loosens the cap it exists to enforce.
 */

/**
 * Returns holds' amounts to the channel's monthly ledger.
 *
 * Three rules the callers must not be allowed to get wrong independently:
 *
 *  - **One transaction per hold, delete before decrement.** The delete *is* the
 *    claim. Two parties racing the same hold cannot both refund it, because the
 *    loser's delete raises and it skips. A bulk `deleteMany` cannot do this: it
 *    returns a count, not a set, so a partial delete gives no way to know which
 *    amounts were actually taken.
 *  - **Decrement the hold's own month**, never "now". A hold taken at 23:59 on
 *    the last of the month settles or expires in the next one, and crediting
 *    the wrong row leaks the hold on the old month and drives the new one
 *    negative.
 *  - **Never touch `runsCompleted`.** It counts turns that really happened; a
 *    refund is not one.
 *
 * Best-effort throughout: a failed refund must not stop the caller. Returns
 * what was actually reclaimed, not what was found.
 */
export async function releaseChannelBudgetHolds(
  client: BudgetClient,
  channelId: string,
  opts:
    | { expiredOnly: true }
    /** The admin reset: every hold in one month, expired or not. */
    | { expiredOnly: false; yearMonth: string }
): Promise<{ released: number; reclaimedUsd: number }> {
  let holds: { amountUsd: unknown; id: string; yearMonth: string }[];
  try {
    holds = await client.channelBudgetHold.findMany({
      select: { amountUsd: true, id: true, yearMonth: true },
      where: opts.expiredOnly
        ? { channelId, expiresAt: { lt: new Date() } }
        : { channelId, yearMonth: opts.yearMonth },
    });
  } catch (err) {
    console.error(
      `[channelBudget] failed to list budget holds for ${channelId}:`,
      err instanceof Error ? err.message : err
    );
    return { reclaimedUsd: 0, released: 0 };
  }

  let released = 0;
  let reclaimedUsd = 0;
  for (const hold of holds) {
    const amountUsd = Number(hold.amountUsd);
    try {
      await client.$transaction(async (tx) => {
        await tx.channelBudgetHold.delete({ where: { id: hold.id } });
        await tx.channelMonthlyUsage.update({
          data: { costUsdAccrued: { decrement: amountUsd } },
          where: { channelId_yearMonth: { channelId, yearMonth: hold.yearMonth } },
        });
      });
      released++;
      reclaimedUsd += amountUsd;
    } catch {
      // Another sweeper, a settling turn, or an admin reset won the row — or its
      // ledger row is gone. Either way this hold is no longer ours to refund,
      // and whoever took it has already accounted for it.
    }
  }
  return { reclaimedUsd, released };
}
