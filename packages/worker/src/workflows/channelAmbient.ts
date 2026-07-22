import { log, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import {
  RETRY_LLM_LIGHT,
  RETRY_ONCE_SLOW,
  RETRY_RUN_RECORD,
  T_5M,
  T_10M,
  T_30S,
} from './proxyOptions.js';

/**
 * ChannelAmbientWorkflow — channel assistant (Phase 3 + Gap F).
 *
 * Started BY NAME by the gateway's per-channel Temporal Schedule, which fires on
 * the channel's `ambientCron`. Name MUST be `'ChannelAmbientWorkflow'`, task
 * queue `'engineering-workflow'`, single arg `{ channelId: string }`.
 *
 * Five activities run on each fire (each best-effort — a failure never blocks the rest):
 *  1. `runChannelAmbientDigest` — proactively posts a short digest to the
 *     channel, surfacing recent/forgotten memory items (budget-gated, noise-averse).
 *  2. `consolidateChannelMemory` (Gap F) — clusters similar channel-memory items,
 *     synthesises each qualifying cluster into 1–2 durable facts, and soft-deletes
 *     the source rows. Best-effort: a consolidation failure never blocks the digest.
 *  3. `sweepChannelOpenItems` (Gap C) — detects new open action items / questions
 *     in recent channel history, tracks them, marks resolved ones, and nudges stale
 *     items that haven't had a follow-up. Best-effort: runs after consolidation.
 *  4. `passiveIngestChannelMemory` — silently extracts salient facts from recent
 *     human messages and writes them to channel memory. Opt-in per channel
 *     (`passiveIngestEnabled`).
 *  5. `flagOrgSignals` (Gap B) — surfaces notable activity from OTHER (non-private)
 *     channels in the same org into this channel. Opt-in (`orgFlaggingEnabled`),
 *     cooldown-rate-limited, private-source-excluded (Gap G).
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`;
 * runtime imports come from `@temporalio/workflow` and the activity proxies below.
 */

const { runChannelAmbientDigest } = proxyActivities<
  Pick<typeof activitiesType, 'runChannelAmbientDigest'>
>({
  retry: RETRY_LLM_LIGHT,
  startToCloseTimeout: T_5M,
});

// Gap F: channel memory consolidation — heavier than the digest (LLM synthesis
// per cluster), so give it a longer timeout and only one retry.
const { consolidateChannelMemory } = proxyActivities<
  Pick<typeof activitiesType, 'consolidateChannelMemory'>
>({
  retry: RETRY_ONCE_SLOW,
  startToCloseTimeout: T_10M,
});

// Gap C: open-item sweep — detect new action items, mark resolved ones, nudge
// stale ones. Same single-retry, longer timeout as consolidation.
const { sweepChannelOpenItems } = proxyActivities<
  Pick<typeof activitiesType, 'sweepChannelOpenItems'>
>({
  retry: RETRY_ONCE_SLOW,
  startToCloseTimeout: T_5M,
});

// Passive memory ingestion — silently extract salient facts from human messages.
// Single attempt, 5 min timeout (LLM + per-fact embedding writes).
const { passiveIngestChannelMemory } = proxyActivities<
  Pick<typeof activitiesType, 'passiveIngestChannelMemory'>
>({
  retry: RETRY_ONCE_SLOW,
  startToCloseTimeout: T_5M,
});

// Gap B: org-wide proactive flagging — surface notable activity from other
// (non-private) channels in the org. Opt-in per channel; single attempt.
const { flagOrgSignals } = proxyActivities<Pick<typeof activitiesType, 'flagOrgSignals'>>({
  retry: RETRY_ONCE_SLOW,
  startToCloseTimeout: T_5M,
});

// Run-record lifecycle (observability): a lightweight WorkflowRun keyed to this
// Temporal workflowId so the digest's agent traces persist + appear in /runs.
const { startChannelRun, finalizeChannelRun } = proxyActivities<
  Pick<typeof activitiesType, 'startChannelRun' | 'finalizeChannelRun'>
>({
  retry: RETRY_RUN_RECORD,
  startToCloseTimeout: T_30S,
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

  // Gap C: sweep open items after consolidation. Best-effort — a sweep failure
  // must not affect the digest or consolidation outcomes.
  try {
    await sweepChannelOpenItems({ channelId: input.channelId });
  } catch (err) {
    log.warn('ChannelAmbientWorkflow: sweepChannelOpenItems failed (best-effort)', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Passive memory ingestion — silently extract facts from recent human messages.
  // Best-effort: a failure here must not affect the other activities.
  try {
    await passiveIngestChannelMemory({ channelId: input.channelId });
  } catch (err) {
    log.warn('ChannelAmbientWorkflow: passiveIngestChannelMemory failed (best-effort)', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Gap B: org-wide proactive flagging — surface cross-channel signals into this
  // channel (opt-in, private-source-excluded). Best-effort: a failure here must
  // not affect the digest/consolidation/sweep/ingest outcomes.
  try {
    await flagOrgSignals({ channelId: input.channelId });
  } catch (err) {
    log.warn('ChannelAmbientWorkflow: flagOrgSignals failed (best-effort)', {
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
