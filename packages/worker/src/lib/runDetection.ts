import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { currentTemporalRunId, currentWorkflowId } from './activityContext.js';

/**
 * The stack detection of every connection in `connectionIds`, as `{ id: detectedStack | null }`.
 * A connection with no detection maps to `null`: nothing was recorded for it when the run began,
 * which in practice is a repository the scan has not reached yet (a scan always writes a non-null
 * value). It is pinned anyway, so the run is consistent with itself. An id that does not exist is
 * left out, so it reads live.
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
 * Pin the detections of `connectionIds` on the run, and record which execution took the pin
 * (`pinnedDetectionsFor`). The write happens only while the column is NULL, or when it was taken
 * by a DIFFERENT execution: so an attempt or a retry of one execution keeps that execution's
 * first pin — including a slow earlier attempt finishing after a later one — while a later
 * execution that reuses the workflow id takes a fresh snapshot. It is a column of its own because
 * `temporalRunId` is written on create only (it names the FIRST execution, for the launcher
 * credential check), so a rule built on it would re-pin on every attempt of a later execution.
 * A pin with no recorded execution (NULL) is never overwritten, since SQL `NULL <> x` is not true.
 * Outside an activity there is no current execution: only the NULL column is written.
 */
export async function pinDetectionsOnRun(
  runId: string,
  connectionIds: readonly string[]
): Promise<void> {
  const snapshot = await snapshotDetections(connectionIds);
  const executionId = currentTemporalRunId();
  const unpinned = { pinnedDetections: { equals: Prisma.DbNull } };
  await prisma.workflowRun.updateMany({
    data: {
      pinnedDetections: snapshot as Prisma.InputJsonObject,
      pinnedDetectionsFor: executionId,
    },
    where: {
      id: runId,
      OR: executionId ? [unpinned, { pinnedDetectionsFor: { not: executionId } }] : [unpinned],
    },
  });
}

/**
 * The detection the current run pinned for `repo`, or `repo.detectedStack` when it pinned none.
 *
 * Pinned means an OWN key `repo.id` in the run's `pinnedDetections`, read from the row with the
 * run's workflow id (unique per run, and unchanged by a re-run or a Temporal reset). Its value may
 * be `null` — nothing was recorded when the run began — and that must not fall through to a scan
 * that landed later. The
 * column is untrusted JSON, so anything but a plain object is ignored. Never throws: outside an
 * activity, with no run row, or with the database down, the live value is what the code read
 * before the pin existed.
 */
export async function detectedStackForRun(repo: {
  id: string;
  detectedStack?: unknown;
}): Promise<unknown> {
  try {
    const run = await prisma.workflowRun.findUnique({
      select: { pinnedDetections: true },
      where: { workflowId: currentWorkflowId() },
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
