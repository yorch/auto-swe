import { log, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import { RETRY_LLM_LIGHT, RETRY_RUN_RECORD, T_30S } from './proxyOptions.js';

/**
 * ChannelReactiveWorkflow — channel assistant (Gap A: reactive interjection).
 *
 * Started BY NAME by the gateway's per-channel reactive Temporal Schedule, which
 * fires on the channel's `reactiveCron`. Name MUST be `'ChannelReactiveWorkflow'`,
 * task queue `'engineering-workflow'`, single arg `{ channelId: string }`.
 *
 * Each fire runs `evaluateReactiveInterjection`, which polls recent channel
 * history and lets the assistant proactively chime in when (and only when) it has
 * something genuinely useful to add — gated by a new-message check, the channel
 * budget, and a cooldown so it never becomes a firehose responder.
 *
 * V8-isolate rule: only `import type` from external packages; runtime imports come
 * from `@temporalio/workflow` and the activity proxies below.
 */

const { evaluateReactiveInterjection } = proxyActivities<
  Pick<typeof activitiesType, 'evaluateReactiveInterjection'>
>({
  retry: RETRY_LLM_LIGHT,
  startToCloseTimeout: '3m',
});

// Run-record lifecycle (observability): a lightweight WorkflowRun keyed to this
// Temporal workflowId so the interjection's agent traces persist + appear in /runs.
const { startChannelRun, finalizeChannelRun } = proxyActivities<
  Pick<typeof activitiesType, 'startChannelRun' | 'finalizeChannelRun'>
>({
  retry: RETRY_RUN_RECORD,
  startToCloseTimeout: T_30S,
});

export async function ChannelReactiveWorkflow(input: { channelId: string }): Promise<void> {
  // Create the run record FIRST so the interjection's agent traces resolve a runId
  // and persist. team/org are backfilled from the channel row inside startChannelRun
  // (the reactive trigger only carries channelId). Best-effort.
  const workflowId = workflowInfo().workflowId;
  try {
    await startChannelRun({
      channelId: input.channelId,
      kind: 'reactive',
      label: input.channelId,
      workflowId,
    });
  } catch (err) {
    log.warn('ChannelReactiveWorkflow: startChannelRun failed; traces may not persist', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let runStatus: 'SUCCESS' | 'FAILED' = 'SUCCESS';
  try {
    // The activity is best-effort by design (returns an outcome, never throws for
    // a no-op); a thrown error here means an infrastructure failure worth recording.
    await evaluateReactiveInterjection(input);
  } catch (err) {
    runStatus = 'FAILED';
    log.error('ChannelReactiveWorkflow failed', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await finalizeChannelRun({ status: runStatus, workflowId });
  } catch (err) {
    log.warn('ChannelReactiveWorkflow: finalizeChannelRun failed', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
