import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

const { retryReviewFix } = proxyActivities<Pick<typeof activities, 'retryReviewFix'>>({
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: '3m',
});

export async function reviewFixRetryWorkflow(input: {
  runId: string;
  attemptId: string;
  automationId?: string;
}) {
  return await retryReviewFix(input);
}
