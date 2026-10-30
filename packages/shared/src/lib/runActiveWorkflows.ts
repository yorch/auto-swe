import type { PrismaClient } from '../index.js';
import { runUnscoped } from './tenantGuard.js';

export interface MatchingActiveWorkflow {
  costUsdAccrued: number | { toNumber(): number };
  temporalWorkflowId: string;
}

const ID_CHUNK = 1_000;

/**
 * The ledger row (`ActiveWorkflow`) of each run, keyed by the run's Temporal workflow id.
 *
 * Selecting `workRequest.activeWorkflows` on a run returns every sibling workflow of its request,
 * so an epic of N children reads N rows N times. `temporalWorkflowId` is unique, so one lookup by
 * the runs' own ids returns exactly the row each run needs.
 */
export async function matchingActiveWorkflows(
  db: Pick<PrismaClient, 'activeWorkflow'>,
  workflowIds: readonly string[]
): Promise<Map<string, MatchingActiveWorkflow>> {
  const byWorkflowId = new Map<string, MatchingActiveWorkflow>();
  const ids = [...new Set(workflowIds)];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    const rows = await runUnscoped(
      'rollup sources read the ledger row that matches each selected run',
      ['ActiveWorkflow'],
      () =>
        db.activeWorkflow.findMany({
          select: { costUsdAccrued: true, temporalWorkflowId: true },
          where: { temporalWorkflowId: { in: ids.slice(offset, offset + ID_CHUNK) } },
        })
    );
    for (const row of rows) {
      byWorkflowId.set(row.temporalWorkflowId, row);
    }
  }
  return byWorkflowId;
}

/** Shape a run for `workflowRunRollupInputFromRun` with only its own ledger row attached. */
export function withMatchingActiveWorkflow<T extends { workflowId: string }>(
  run: T,
  matches: ReadonlyMap<string, MatchingActiveWorkflow>
): T & { workRequest: { activeWorkflows: MatchingActiveWorkflow[] } } {
  const match = matches.get(run.workflowId);
  return { ...run, workRequest: { activeWorkflows: match ? [match] : [] } };
}
