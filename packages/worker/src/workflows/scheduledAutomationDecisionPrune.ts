import { proxyActivities } from '@temporalio/workflow';
import type { pruneAutomationDecisions as pruneAutomationDecisionsType } from '../activities/pruneAutomationDecisions.js';
import { RETRY_SCHEDULED, T_10M } from './proxyOptions.js';

const { pruneAutomationDecisions } = proxyActivities<{
  pruneAutomationDecisions: typeof pruneAutomationDecisionsType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

export type ScheduledAutomationDecisionPruneResult = Awaited<
  ReturnType<typeof pruneAutomationDecisionsType>
>;

/**
 * Delete event-automation decisions that started no run once they are past their retention,
 * on the cadence set by `AUTOMATION_DECISION_PRUNE_ENABLED` and `AUTOMATION_DECISION_PRUNE_CRON`.
 */
export async function ScheduledAutomationDecisionPruneWorkflow(): Promise<ScheduledAutomationDecisionPruneResult> {
  return pruneAutomationDecisions();
}
