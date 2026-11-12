import { prisma } from '@auto-swe/shared/db';
import { currentRequestWorkflowId } from './config/contextLookup.js';
import type { RecallArm } from './lessonRecallAssignment.js';

/** Identity comes from the activity, never tool arguments or a model-authored payload. */
export async function currentLessonRecallArm(): Promise<RecallArm> {
  const workflowId = currentRequestWorkflowId();
  if (!workflowId) {
    return 'ON';
  }
  const run = await prisma.workflowRun.findUnique({
    select: { lessonRecallArm: true },
    where: { workflowId },
  });
  if (!run) {
    throw new Error('Owning workflow run is unavailable for lesson recall');
  }
  return run.lessonRecallArm ?? 'ON';
}
