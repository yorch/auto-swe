import { prisma } from '@auto-swe/shared/db';
import { activityInfo } from '@temporalio/activity';

/** Agent keys alone are not authority: team admins can override their definitions. */
export async function isOnboardingDraftAgent(agentKey: string): Promise<boolean> {
  if (agentKey !== 'repo-onboarder') {
    return false;
  }
  let execution: ReturnType<typeof activityInfo>['workflowExecution'];
  try {
    execution = activityInfo().workflowExecution;
  } catch {
    return false;
  }
  if (!execution?.workflowId || !execution.runId) {
    return false;
  }
  const run = await prisma.workflowRun.findUnique({
    select: {
      template: { select: { name: true, origin: true, teamId: true } },
      templateId: true,
      templateVersion: true,
      temporalRunId: true,
    },
    where: { workflowId: execution.workflowId },
  });
  if (
    !run ||
    run.temporalRunId !== execution.runId ||
    run.template.name !== 'repo-onboarding' ||
    run.template.teamId !== null ||
    run.template.origin !== 'swe-starter'
  ) {
    return false;
  }
  const version = await prisma.workflowTemplateVersion.findUnique({
    select: { createdBy: true, generatedBy: true },
    where: { templateId_version: { templateId: run.templateId, version: run.templateVersion } },
  });
  return version !== null && version.createdBy === null && version.generatedBy === null;
}
