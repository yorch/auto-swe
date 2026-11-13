import { proxyActivities } from '@temporalio/workflow';
import type { replaceEvalLessons as Replace } from '../activities/evalLessons.js';

const activities = proxyActivities<{ replaceEvalLessons: typeof Replace }>({
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: '5m',
});

export async function ReplaceEvalLessonsWorkflow(
  input: Parameters<typeof Replace>[0]
): Promise<number> {
  return activities.replaceEvalLessons(input);
}
