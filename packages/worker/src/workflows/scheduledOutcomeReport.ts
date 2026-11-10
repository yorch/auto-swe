import { proxyActivities } from '@temporalio/workflow';
import type { generateOutcomeReport as generateOutcomeReportType } from '../activities/generateOutcomeReport.js';
import { RETRY_SCHEDULED, T_30M } from './proxyOptions.js';

const { generateOutcomeReport } = proxyActivities<{
  generateOutcomeReport: typeof generateOutcomeReportType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_30M,
});

export type ScheduledOutcomeReportResult = Awaited<ReturnType<typeof generateOutcomeReportType>>;

/**
 * Regenerate the outcome report on the cadence set by `OUTCOME_REPORT_ENABLED` and
 * `OUTCOME_REPORT_CRON`. One activity; it reads run data and stores one snapshot.
 */
export async function ScheduledOutcomeReportWorkflow(): Promise<ScheduledOutcomeReportResult> {
  return generateOutcomeReport();
}
