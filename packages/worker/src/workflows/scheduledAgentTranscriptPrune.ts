import { log, proxyActivities } from '@temporalio/workflow';
import type { pruneAgentTranscripts as pruneAgentTranscriptsType } from '../activities/pruneAgentTranscripts.js';
import type { pruneUiEvidence as pruneUiEvidenceType } from '../activities/pruneUiEvidence.js';
import { RETRY_SCHEDULED, T_10M } from './proxyOptions.js';

const { pruneAgentTranscripts, pruneUiEvidence } = proxyActivities<{
  pruneAgentTranscripts: typeof pruneAgentTranscriptsType;
  pruneUiEvidence: typeof pruneUiEvidenceType;
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
  const result = await pruneAgentTranscripts();
  try {
    await pruneUiEvidence();
  } catch (err) {
    log.warn('ScheduledAgentTranscriptPruneWorkflow: UI evidence pruning failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}
