import { log, proxyActivities, workflowInfo } from '@temporalio/workflow';
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

// Run-record lifecycle (observability): a lightweight WorkflowRun keyed to this
// Temporal workflowId so the digest's agent traces persist + appear in /runs.
const { startChannelRun, finalizeChannelRun } = proxyActivities<
  Pick<typeof activitiesType, 'startChannelRun' | 'finalizeChannelRun'>
>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '2s',
    maximumAttempts: 3,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '30s',
});

export async function ChannelAmbientWorkflow(input: { channelId: string }): Promise<void> {
  // Create the run record FIRST so the digest's agent traces resolve a runId and
  // persist. team/org are backfilled from the channel row inside startChannelRun
  // (the ambient trigger only carries channelId). Best-effort — a failure here
  // must not stop the digest (it's noise-averse + best-effort by design).
  const workflowId = workflowInfo().workflowId;
  try {
    await startChannelRun({
      channelId: input.channelId,
      kind: 'ambient',
      label: input.channelId,
      workflowId,
    });
  } catch (err) {
    log.warn('ChannelAmbientWorkflow: startChannelRun failed; traces may not persist', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let runStatus: 'SUCCESS' | 'FAILED' = 'SUCCESS';
  try {
    await runChannelAmbientDigest(input);
  } catch (err) {
    runStatus = 'FAILED';
    log.error('ChannelAmbientWorkflow failed', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  } finally {
    try {
      await finalizeChannelRun({ status: runStatus, workflowId });
    } catch (err) {
      log.warn('ChannelAmbientWorkflow: finalizeChannelRun failed', {
        channelId: input.channelId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
