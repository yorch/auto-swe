import { proxyActivities } from '@temporalio/workflow';
import type { pruneAgentTranscripts as pruneAgentTranscriptsType } from '../activities/pruneAgentTranscripts.js';
import { RETRY_SCHEDULED, T_10M } from './proxyOptions.js';

const { pruneAgentTranscripts } = proxyActivities<{
  pruneAgentTranscripts: typeof pruneAgentTranscriptsType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

export type ScheduledAgentTranscriptPruneResult = Awaited<
  ReturnType<typeof pruneAgentTranscriptsType>
>;

/**
 * Delete agent transcripts past their retention (never those under legal hold),
 * mark stale open ones abandoned, and remove orphan part artifacts, on the
 * cadence set by `AGENT_TRANSCRIPT_PRUNE_ENABLED` and `AGENT_TRANSCRIPT_PRUNE_CRON`.
 */
export async function ScheduledAgentTranscriptPruneWorkflow(): Promise<ScheduledAgentTranscriptPruneResult> {
  return pruneAgentTranscripts();
}
