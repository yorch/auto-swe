import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { currentRunningWorkflowRunId } from './activityContext.js';

/**
 * The stack detection of every connection in `connectionIds`, as `{ id: detectedStack | null }`.
 * A connection with no detection maps to `null` — a real pin meaning "no detection" — and an id
 * that does not exist is left out, so it reads live.
 */
export async function snapshotDetections(
  connectionIds: readonly string[]
): Promise<Record<string, unknown>> {
  if (connectionIds.length === 0) {
    return {};
  }
  const rows = await runUnscoped(
    'ids come from the run’s already-authorized connection set; scoped by id, not by tenant',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: { detectedStack: true, id: true },
        where: { id: { in: [...connectionIds] } },
      })
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.detectedStack ?? null]));
}

/**
 * Pin the detections of `connectionIds` on the run, once. The first writer wins: a Temporal retry
 * or a re-entered activity finds the column set and writes nothing, and a row that pre-dates the
 * column is filled the first time it is seen.
 */
export async function pinDetectionsOnRun(
  runId: string,
  connectionIds: readonly string[]
): Promise<void> {
  const snapshot = await snapshotDetections(connectionIds);
  await prisma.workflowRun.updateMany({
    data: { pinnedDetections: snapshot as Prisma.InputJsonObject },
    where: { id: runId, pinnedDetections: { equals: Prisma.DbNull } },
  });
}

/**
 * The detection the current run pinned for `repo`, or `repo.detectedStack` when it pinned none.
 *
 * Pinned means an OWN key `repo.id` in the run's `pinnedDetections` — its value may be `null`,
 * which is a real pin ("no detection") and must not fall through to a scan that landed later. The
 * column is untrusted JSON, so anything but a plain object is ignored. Never throws: outside an
 * activity, with no run row, or with the database down, the live value is what the code read
 * before the pin existed.
 */
export async function detectedStackForRun(repo: {
  id: string;
  detectedStack?: unknown;
}): Promise<unknown> {
  try {
    const runId = await currentRunningWorkflowRunId();
    if (!runId) {
      return repo.detectedStack;
    }
    const run = await prisma.workflowRun.findUnique({
      select: { pinnedDetections: true },
      where: { id: runId },
    });
    const pinned = run?.pinnedDetections;
    if (pinned && typeof pinned === 'object' && !Array.isArray(pinned)) {
      if (Object.hasOwn(pinned, repo.id)) {
        return (pinned as Record<string, unknown>)[repo.id];
      }
    }
  } catch {
    // Fall through: a failed read means the live value, never a failed activity.
  }
  return repo.detectedStack;
}

/** `repo` with its `detectedStack` replaced by the one the current run pinned. */
export async function withRunDetection<T extends { id: string; detectedStack?: unknown }>(
  repo: T
): Promise<T> {
  return { ...repo, detectedStack: await detectedStackForRun(repo) };
}
