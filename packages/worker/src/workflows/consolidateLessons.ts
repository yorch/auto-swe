import type {
  ConsolidateLessonsInput,
  ConsolidateLessonsResult,
} from '@auto-swe/shared/types/workflow';
import { proxyActivities } from '@temporalio/workflow';
import type { consolidateLessons as consolidateLessonsActivity } from '../activities/consolidateLessons.js';

const { consolidateLessons } = proxyActivities<{
  consolidateLessons: typeof consolidateLessonsActivity;
}>({
  // Allow up to 30 min: large lesson stores with many clusters need time for
  // N LLM calls + embedding round-trips.
  scheduleToCloseTimeout: '30 minutes',
  startToCloseTimeout: '25 minutes',
});

export async function ConsolidateLessonsWorkflow(
  input: ConsolidateLessonsInput
): Promise<ConsolidateLessonsResult> {
  return consolidateLessons(input);
}
