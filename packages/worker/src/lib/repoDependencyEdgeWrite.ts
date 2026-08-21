import { prisma } from '@auto-swe/shared/db';

/**
 * The shared read step every repo-dependency writer performs before it writes.
 *
 * Two detectors write edges — the deterministic manifest/git-signal scan and the
 * LLM inferrer — and both must honour the same rule: **a `dismissed` edge is a
 * sticky human veto and is never resurrected.** That rule lived in both writers,
 * which meant getting it right twice; it lives here now so there is one place to
 * be correct and one place to test.
 *
 * Prisma cannot `upsert` on a partial unique index (the graph has one index for
 * resolved edges and another for unresolved suggestions), so every writer does
 * find-then-create-or-update. This is the find half.
 */

export interface EdgeNaturalKey {
  fromRepoId: string;
  kind: string;
  source: string;
  /** Set for an unresolved suggestion; null for a resolved edge. */
  toRef: string | null;
  /** Set for a resolved edge; null for an unresolved suggestion. */
  toRepoId: string | null;
}

export type EdgeWriteTarget =
  /** A human vetoed this pair — the caller must write nothing at all. */
  | { kind: 'vetoed' }
  /** No row yet: the caller creates one. */
  | { kind: 'absent' }
  /** A live row: the caller refreshes it, but must not change `status`. */
  | { kind: 'existing'; id: string };

/** Look up the row for `key` and classify what the caller may do with it. */
export async function findEdgeWriteTarget(key: EdgeNaturalKey): Promise<EdgeWriteTarget> {
  const existing = await prisma.repoDependency.findFirst({
    where: {
      fromRepoId: key.fromRepoId,
      kind: key.kind,
      source: key.source,
      toRef: key.toRef,
      toRepoId: key.toRepoId,
    },
  });
  if (!existing) {
    return { kind: 'absent' };
  }
  if (existing.status === 'dismissed') {
    return { kind: 'vetoed' };
  }
  return { id: existing.id, kind: 'existing' };
}
