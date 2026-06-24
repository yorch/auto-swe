import { log, proxyActivities } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';

/**
 * ChannelAmbientWorkflow — channel assistant (Phase 3, ambient mode).
 *
 * Started BY NAME by the gateway's per-channel Temporal Schedule, which fires on
 * the channel's `ambientCron`. Name MUST be `'ChannelAmbientWorkflow'`, task
 * queue `'engineering-workflow'`, single arg `{ channelId: string }`.
 *
 * It runs one activity that proactively posts a short digest to the channel
 * (surfacing recent / forgotten memory items), budget-gated and noise-averse.
 * The activity itself never throws (logs + returns); this workflow additionally
 * swallows any error so a scheduled run can't loop loudly or spam the channel.
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`;
 * runtime imports come from `@temporalio/workflow` and the activity proxy below.
 */

const { runChannelAmbientDigest } = proxyActivities<
  Pick<typeof activitiesType, 'runChannelAmbientDigest'>
>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '10s',
    maximumAttempts: 2,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '5m',
});

export async function ChannelAmbientWorkflow(input: { channelId: string }): Promise<void> {
  try {
    await runChannelAmbientDigest(input);
  } catch (err) {
    log.error('ChannelAmbientWorkflow failed', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
