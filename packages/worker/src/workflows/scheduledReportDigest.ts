import { proxyActivities, sleep } from '@temporalio/workflow';
import type { sendReportDigests } from '../activities/sendReportDigests.js';

const activities = proxyActivities<{ sendReportDigests: typeof sendReportDigests }>({
  startToCloseTimeout: '30 minutes',
});

export async function ScheduledReportDigestWorkflow(input?: {
  sendTest?: boolean;
  subscriptionId?: string;
}) {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await activities.sendReportDigests(input);
    sent += result.sent;
    failed = result.failed;
    skipped += result.skipped;
    if (input?.sendTest || result.failed === 0 || attempt === 3) {
      break;
    }
    await sleep('15 minutes');
  }
  return { failed, sent, skipped };
}
