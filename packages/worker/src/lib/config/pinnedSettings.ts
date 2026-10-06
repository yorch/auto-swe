import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';

/// A `WorkflowRun.pinnedSettings` value as a record, or null when the column is
/// unset or holds something other than a JSON object (a hand-edited row).
export function asPinnedSettings(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/// True when `stored` already holds every one of `keys`.
export function hasEveryPin(stored: unknown, keys: readonly string[]): boolean {
  const have = asPinnedSettings(stored);
  return have !== null && keys.every((key) => key in have);
}

/// The run's pinned settings with every key of `fresh` it lacks added at its
/// fresh value. A value already pinned is never changed: the run may have made a
/// decision on it. A key the snapshot lacks — the row pre-dates the column, or
/// the setting was declared `runPinned` after the run started — would otherwise
/// resolve live for the rest of the run, and could flip between two of its
/// activities; pinning it now stops that from here on.
///
/// Written only when a key is missing, and as a compare-and-set on the stored
/// value, so two writers racing cannot overwrite each other: the loser re-reads,
/// finds the keys present, and returns what is stored. Without a missing key this
/// costs no query.
///
/// Returns null when the row kept changing underneath for every attempt, or no
/// longer exists; the caller decides whether that is retryable or degrades.
export async function backfillPinnedSettings(
  runId: string,
  stored: unknown,
  fresh: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  let current = asPinnedSettings(stored);
  for (let attempt = 0; attempt < 3; attempt++) {
    const have = current;
    if (have && Object.keys(fresh).every((key) => key in have)) {
      return have;
    }
    const merged = { ...fresh, ...current };
    const { count } = await prisma.workflowRun.updateMany({
      data: { pinnedSettings: merged as Prisma.InputJsonObject },
      where: {
        id: runId,
        pinnedSettings: current
          ? { equals: current as Prisma.InputJsonObject }
          : { equals: Prisma.DbNull },
      },
    });
    if (count > 0) {
      return merged;
    }
    const row = await prisma.workflowRun.findUnique({
      select: { pinnedSettings: true },
      where: { id: runId },
    });
    if (!row) {
      return null;
    }
    current = asPinnedSettings(row.pinnedSettings);
  }
  return null;
}
