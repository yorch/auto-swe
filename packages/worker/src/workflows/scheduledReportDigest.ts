import { proxyActivities } from '@temporalio/workflow';
import type { sendReportDigests } from '../activities/sendReportDigests.js';

const activities = proxyActivities<{ sendReportDigests: typeof sendReportDigests }>({
  startToCloseTimeout: '30 minutes',
});

export async function ScheduledReportDigestWorkflow(input?: {
  sendTest?: boolean;
  subscriptionId?: string;
}) {
  return activities.sendReportDigests(input);
}
