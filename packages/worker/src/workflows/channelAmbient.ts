import { log, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';

/**
 * ChannelAmbientWorkflow — channel assistant (Phase 3 + Gap F).
 *
 * Started BY NAME by the gateway's per-channel Temporal Schedule, which fires on
 * the channel's `ambientCron`. Name MUST be `'ChannelAmbientWorkflow'`, task
 * queue `'engineering-workflow'`, single arg `{ channelId: string }`.
 *
 * Two activities run on each fire:
 *  1. `runChannelAmbientDigest` — proactively posts a short digest to the
 *     channel, surfacing recent/forgotten memory items (budget-gated, noise-averse).
 *  2. `consolidateChannelMemory` (Gap F) — clusters similar channel-memory items,
 *     synthesises each qualifying cluster into 1–2 durable facts, and soft-deletes
 *     the source rows. Best-effort: a consolidation failure never blocks the digest.
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`;
 * runtime imports come from `@temporalio/workflow` and the activity proxies below.
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

// Gap F: channel memory consolidation — heavier than the digest (LLM synthesis
// per cluster), so give it a longer timeout and only one retry.
const { consolidateChannelMemory } = proxyActivities<
  Pick<typeof activitiesType, 'consolidateChannelMemory'>
>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '30s',
    maximumAttempts: 1,
  },
  startToCloseTimeout: '10m',
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
  }

  // Gap F: consolidate channel memory on the same ambient schedule. Best-effort —
  // a consolidation failure must not flip the run status or resurface as an error.
  try {
    await consolidateChannelMemory({ channelId: input.channelId });
  } catch (err) {
    log.warn('ChannelAmbientWorkflow: consolidateChannelMemory failed (best-effort)', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await finalizeChannelRun({ status: runStatus, workflowId });
  } catch (err) {
    log.warn('ChannelAmbientWorkflow: finalizeChannelRun failed', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
