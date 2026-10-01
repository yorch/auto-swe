/**
 * What an epic's child row shows in its "Run" column.
 *
 *  - `run`         — the viewer can see the child's WorkflowRun; link to it.
 *  - `not-started` — the child has no Temporal workflow yet.
 *  - `starting`    — it has one, but the run is not listed yet: still
 *                    registering (PENDING / STARTING), or the run list has not
 *                    loaded.
 *  - `no-access`   — the child is past starting and the run list settled
 *                    without it. The run exists (runs are created when the
 *                    child starts), so the viewer cannot see it — typically it
 *                    belongs to a team they are not a member of. Saying
 *                    "starting…" here would be wrong forever.
 */
export type EpicChildRunCell =
  | { kind: 'run'; runId: string }
  | { kind: 'not-started' }
  | { kind: 'starting' }
  | { kind: 'no-access' };

const STARTING_STATUSES = new Set(['PENDING', 'STARTING']);

export function epicChildRunCell(
  child: { temporalWorkflowId: string | null; status: string },
  runIdByTemporalId: ReadonlyMap<string, string>,
  runsSettled: boolean
): EpicChildRunCell {
  if (!child.temporalWorkflowId) {
    return { kind: 'not-started' };
  }
  const runId = runIdByTemporalId.get(child.temporalWorkflowId);
  if (runId) {
    return { kind: 'run', runId };
  }
  if (!runsSettled || STARTING_STATUSES.has(child.status)) {
    return { kind: 'starting' };
  }
  return { kind: 'no-access' };
}
