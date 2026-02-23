import { prisma } from '@auto-swe/shared/db';

export async function updateDomainState(
  workRequestId: string,
  status: string,
): Promise<void> {
  await prisma.activeWorkflow.updateMany({
    where: { workRequestId },
    data: { currentStatus: status },
  });
}
