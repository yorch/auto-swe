import { proxyActivities, sleep, workflowInfo } from '@temporalio/workflow';
import type { sendReportDigests } from '../activities/sendReportDigests.js';
import { RETRY_SCHEDULED } from './proxyOptions.js';

const activities = proxyActivities<{ sendReportDigests: typeof sendReportDigests }>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: '30 minutes',
});

const testActivities = proxyActivities<{ sendReportDigests: typeof sendReportDigests }>({
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: '30 minutes',
});

function previousIsoWeekStart(startTime: Date): Date {
  const day = startTime.getUTCDay() || 7;
  const thisMonday = Date.UTC(
    startTime.getUTCFullYear(),
    startTime.getUTCMonth(),
    startTime.getUTCDate() - day + 1
  );
  return new Date(thisMonday - 7 * 24 * 60 * 60 * 1000);
}

export async function ScheduledReportDigestWorkflow(input?: {
  sendTest?: boolean;
  subscriptionId?: string;
}) {
  const activityInput = {
    ...input,
    periodStart: previousIsoWeekStart(workflowInfo().runStartTime),
  };
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const activity = input?.sendTest ? testActivities : activities;
    const result = await activity.sendReportDigests(activityInput);
    sent += result.sent;
    failed = result.failed;
    skipped += result.skipped;
    if (result.rollupIncomplete > 0) {
      maxAttempts = 6;
    }
    if (
      input?.sendTest ||
      (result.failed === 0 && result.rollupIncomplete === 0) ||
      attempt === maxAttempts
    ) {
      break;
    }
    await sleep('15 minutes');
  }
  return { failed, sent, skipped };
}
