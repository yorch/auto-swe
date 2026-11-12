import { prisma } from '@auto-swe/shared/db';
import { currentTemporalRunId, currentWorkflowId } from './activityContext.js';
import type { RecallArm } from './lessonRecallAssignment.js';

/** Identity comes from the activity, never tool arguments or a model-authored payload. */
export async function currentLessonRecallArm(): Promise<RecallArm> {
  if (!currentTemporalRunId()) {
    return 'ON';
  }
  const run = await prisma.workflowRun.findUnique({
    select: { lessonRecallArm: true },
    where: { workflowId: currentWorkflowId() },
  });
  return run?.lessonRecallArm ?? 'ON';
}
