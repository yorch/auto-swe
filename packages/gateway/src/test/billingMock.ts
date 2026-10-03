/**
 * Stand-in for `orgMonthSpend` in route tests, where Prisma is a hand-built
 * mock: it reads only the mock's `orgMonthlyUsage` row, so a test sets an org's
 * spend the way it always has. The real function is tested in
 * `shared/src/lib/billing.test.ts`. Use it from a `vi.mock` factory:
 *
 *   vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
 *     ...(await importOriginal<object>()),
 *     ...(await import('../test/billingMock.js')),
 *   }));
 */
export async function orgMonthSpend(
  db: {
    orgMonthlyUsage?: {
      findUnique: (args: unknown) => Promise<{ costUsdAccrued: unknown } | null>;
    };
  },
  orgId: string
) {
  const yearMonth = new Date().toISOString().slice(0, 7);
  const usage = await db.orgMonthlyUsage?.findUnique({
    where: { orgId_yearMonth: { orgId, yearMonth } },
  });
  const finalizedUsd = Number(usage?.costUsdAccrued ?? 0);
  return { finalizedUsd, inFlightUsd: 0, runlessUsd: 0, totalUsd: finalizedUsd };
}
