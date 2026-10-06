import type { Prisma } from '../index.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * Forgetting a memory item, so that nothing derived from it outlives it.
 *
 * A memory's text can live in more rows than the one an admin deletes:
 * consolidation copies it into a merged row (`metadata.consolidatedFrom` lists
 * the sources) and marks the sources consolidated; supersession marks an older
 * row replaced by a newer one. Deleting one row alone would leave its content
 * recalled through a merged copy, or strand the rows it had hidden.
 *
 * The rule, from the rows the caller names (the *targets*):
 *
 * - **Up**: every row consolidated from a forgotten row is forgotten, recursively —
 *   it carries the forgotten content.
 * - **Down**: a target that is itself a merged row takes its sources with it,
 *   recursively — they hold the same content, and restoring them would bring
 *   back what the admin just removed. Rows only reached going up do not pull
 *   their other sources down.
 * - **Restored**: a source of a merged row forgotten on the way up, which is not
 *   itself forgotten and no surviving merged row lists, is made active again
 *   (`consolidated_at` cleared). It was hidden only because the merge stood for
 *   it; consolidation can merge it again later, without the forgotten row.
 * - **Un-superseded**: a row the forgotten rows had superseded is made active
 *   again, its replacement being gone.
 *
 * Runs on the caller's transaction client, so the forget is all or nothing and
 * an audit row the caller writes in the same transaction commits with it.
 */

type Tx = Prisma.TransactionClient;

export interface ForgetResult {
  /** Every row deleted: the targets, then what came with them. */
  deleted: string[];
  /** Rows made active again because what hid them is gone. */
  restored: string[];
}

/** Hard bound on the closure walk; consolidation chains are a few levels deep. */
const MAX_ROUNDS = 32;

const REASON = 'a memory forget follows provenance links by id, across the rows they name';

export async function forgetMemoryItems(
  tx: Tx,
  targetIds: readonly string[]
): Promise<ForgetResult> {
  if (targetIds.length === 0) {
    return { deleted: [], restored: [] };
  }
  return runUnscoped(REASON, ['MemoryItem'], async () => {
    const forgotten = new Set(targetIds);
    const reachedGoingUp = new Set<string>();

    // Down: a merged target takes its sources (and theirs) with it.
    let frontier = [...targetIds];
    for (let round = 0; frontier.length > 0 && round < MAX_ROUNDS; round++) {
      const rows = await tx.memoryItem.findMany({
        select: { id: true, metadata: true },
        where: { id: { in: frontier } },
      });
      frontier = [];
      for (const row of rows) {
        for (const source of consolidatedFrom(row.metadata)) {
          if (!forgotten.has(source)) {
            forgotten.add(source);
            frontier.push(source);
          }
        }
      }
    }

    // Up: anything merged from a forgotten row is forgotten too.
    frontier = [...forgotten];
    for (let round = 0; frontier.length > 0 && round < MAX_ROUNDS; round++) {
      const derived = await derivedFrom(tx, frontier);
      frontier = [];
      for (const row of derived) {
        if (!forgotten.has(row.id)) {
          forgotten.add(row.id);
          reachedGoingUp.add(row.id);
          frontier.push(row.id);
        }
      }
    }

    // Sources of the merged rows retracted on the way up that are not forgotten
    // themselves: candidates for restoring.
    const upRows = await tx.memoryItem.findMany({
      select: { metadata: true },
      where: { id: { in: [...reachedGoingUp] } },
    });
    const candidates = new Set<string>();
    for (const row of upRows) {
      for (const source of consolidatedFrom(row.metadata)) {
        if (!forgotten.has(source)) {
          candidates.add(source);
        }
      }
    }
    // A candidate another surviving merged row still stands for stays hidden.
    const survivors = (await derivedFrom(tx, [...candidates])).filter((r) => !forgotten.has(r.id));
    for (const row of survivors) {
      for (const source of consolidatedFrom(row.metadata)) {
        candidates.delete(source);
      }
    }

    const ids = [...forgotten];
    // Clear supersession before the delete: the foreign key would null
    // `superseded_by_id` but leave `superseded_at`, and with it the row hidden.
    const unsuperseded = await tx.memoryItem.findMany({
      select: { id: true },
      where: { id: { notIn: ids }, supersededById: { in: ids } },
    });
    await tx.memoryItem.updateMany({
      data: { supersededAt: null, supersededById: null },
      where: { id: { notIn: ids }, supersededById: { in: ids } },
    });
    if (candidates.size > 0) {
      await tx.memoryItem.updateMany({
        data: { consolidatedAt: null },
        where: { id: { in: [...candidates] } },
      });
    }
    await tx.memoryItem.deleteMany({ where: { id: { in: ids } } });

    const restored = new Set([...candidates, ...unsuperseded.map((r) => r.id)]);
    return {
      deleted: [...targetIds, ...ids.filter((id) => !targetIds.includes(id))],
      restored: [...restored],
    };
  });
}

/** Rows whose `metadata.consolidatedFrom` names any of `sourceIds`. */
async function derivedFrom(tx: Tx, sourceIds: readonly string[]) {
  if (sourceIds.length === 0) {
    return [];
  }
  return runUnscoped(REASON, ['MemoryItem'], () =>
    tx.memoryItem.findMany({
      select: { id: true, metadata: true },
      where: {
        OR: sourceIds.map((id) => ({
          metadata: { array_contains: [id], path: ['consolidatedFrom'] },
        })),
      },
    })
  );
}

/** The source ids a merged row lists, or none. */
export function consolidatedFrom(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [];
  }
  const from = (metadata as { consolidatedFrom?: unknown }).consolidatedFrom;
  return Array.isArray(from) ? from.filter((x): x is string => typeof x === 'string') : [];
}
