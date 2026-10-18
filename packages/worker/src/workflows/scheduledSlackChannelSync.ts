import { proxyActivities } from '@temporalio/workflow';
import type { syncSlackChannels as syncSlackChannelsType } from '../activities/syncSlackChannels.js';
import { RETRY_SCHEDULED, T_30_MINUTES } from './proxyOptions.js';

const { syncSlackChannels } = proxyActivities<{
  syncSlackChannels: typeof syncSlackChannelsType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_30_MINUTES,
});

export type ScheduledSlackChannelSyncResult = Awaited<ReturnType<typeof syncSlackChannelsType>>;

/**
 * Re-check each Slack channel's privacy and record who is in each private one, on the cadence set
 * by `SLACK_CHANNEL_SYNC_ENABLED` and `SLACK_CHANNEL_SYNC_CRON`. One activity, channels in turn:
 * the cost is Slack quota against one bot token, which a fan-out would spend in a burst.
 */
export async function ScheduledSlackChannelSyncWorkflow(): Promise<ScheduledSlackChannelSyncResult> {
  return syncSlackChannels();
}
