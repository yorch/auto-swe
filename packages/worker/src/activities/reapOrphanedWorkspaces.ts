/**
 * The orphaned-workspace reaper: removes workspace containers and pods that
 * outlived the activity that created them.
 *
 * A workspace is removed in its activity's `finally`. A worker killed or
 * crashed before that leaves the container (Docker has no `--rm` on a
 * workspace) or pod behind, and nothing else removes it. This sweep asks the
 * worker's substrate to remove what no live activity can still own: the driver
 * judges that from the workspace's own marker labels and age
 * (`lib/workspaceBackend/orphans.ts`), never from this process's memory, so a
 * workspace of another worker on the same Docker host or namespace is safe
 * until it is older than any activity could run.
 *
 * It never throws: a sweep that cannot list or remove logs and tries again on
 * the next tick.
 */
import { logWarn } from '../lib/activityLog.js';
import { workspaceBackend } from '../lib/workspaceBackend/index.js';
import type { WorkspaceReapResult } from '../lib/workspaceBackend/orphans.js';

export interface ReapOrphanedWorkspacesResult {
  backend: 'docker' | 'kubernetes' | 'unknown';
  scanned: number;
  removed: number;
  failed: number;
}

export async function reapOrphanedWorkspaces(
  now = new Date()
): Promise<ReapOrphanedWorkspacesResult> {
  let backend: ReturnType<typeof workspaceBackend>;
  try {
    backend = workspaceBackend();
  } catch (err) {
    logWarn('workspace reaper could not resolve the workspace backend', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { backend: 'unknown', failed: 1, removed: 0, scanned: 0 };
  }
  let report: WorkspaceReapResult;
  try {
    report = await backend.reapOrphans(now);
  } catch (err) {
    logWarn('workspace reaper sweep failed', {
      backend: backend.kind,
      err: err instanceof Error ? err.message : String(err),
    });
    return { backend: backend.kind, failed: 1, removed: 0, scanned: 0 };
  }
  for (const id of report.removed) {
    logWarn('workspace reaper removed an orphaned workspace', { backend: backend.kind, id });
  }
  for (const failure of report.failed) {
    logWarn('workspace reaper could not remove a workspace; it is left for the next sweep', {
      backend: backend.kind,
      err: failure.error,
      id: failure.id,
    });
  }
  return {
    backend: backend.kind,
    failed: report.failed.length,
    removed: report.removed.length,
    scanned: report.scanned,
  };
}
