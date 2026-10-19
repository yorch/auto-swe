/**
 * The scheduled Slack channel sync (`lib/slackChannelSync.ts`): re-checks each channel's privacy
 * and replaces each private channel's member list.
 *
 * This runs from a Schedule with no `WorkflowRun` row, and Temporal persists the result and every
 * log line, so both carry ids, counts and Slack's error codes only.
 */
import { log } from '@temporalio/activity';
import {
  type SlackChannelSyncResult,
  syncSlackChannels as sweep,
} from '../lib/slackChannelSync.js';

export type SyncSlackChannelsResult = SlackChannelSyncResult;

export async function syncSlackChannels(): Promise<SyncSlackChannelsResult> {
  const result = await sweep();
  for (const c of result.channels) {
    if (c.madePrivate) {
      log.warn('Slack reports this channel private; its isPrivate flag is now on', {
        channelId: c.channelId,
      });
    }
    if (c.error) {
      log.warn('Slack channel sync could not read this channel; its previous state stands', {
        channelId: c.channelId,
        error: c.error,
      });
    }
  }
  log.info('Slack channel sync complete', {
    checked: result.checked,
    failed: result.failed,
    madePrivate: result.madePrivate,
    membersSynced: result.membersSynced,
    skipped: result.skipped,
  });
  return result;
}
