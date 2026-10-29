import type { PrismaClient } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

export async function claimReportDigestTestSend(
  prisma: Pick<PrismaClient, 'reportDigestSubscription'>,
  subscriptionId: string,
  now: Date
): Promise<boolean> {
  const claim = await runUnscoped(
    'send-test rate limiting claims one report digest subscription',
    ['ReportDigestSubscription'],
    () =>
      prisma.reportDigestSubscription.updateMany({
        data: { lastTestSentAt: now },
        where: {
          id: subscriptionId,
          OR: [
            { lastTestSentAt: null },
            { lastTestSentAt: { lt: new Date(now.getTime() - 60_000) } },
          ],
        },
      })
  );
  return claim.count > 0;
}
