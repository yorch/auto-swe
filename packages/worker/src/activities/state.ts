import { prisma } from '@auto-swe/shared/db';

export async function updateDomainState(temporalWorkflowId: string, status: string): Promise<void> {
  await prisma.activeWorkflow.update({
    data: { currentStatus: status },
    where: { temporalWorkflowId },
  });
}
