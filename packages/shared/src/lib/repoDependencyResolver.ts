import type { PrismaClient } from '../db.js';

/**
 * Read-side resolver for the repo dependency graph. Walks 1 hop in each
 * direction from a git_repo Connection and returns the visible neighbour repos,
 * collapsed across edges. This is the reusable core the P0 management UI reads
 * and later phases inject into agents (review network / implementer / planner).
 *
 * See docs/history/repo-dependency-graph-rfc.md §5. No agent injection happens
 * here — the resolver only returns structured neighbours.
 */

/** A neighbour repo, collapsed across every active edge relating it to the subject. */
export interface RepoDependencyNeighbor {
  repo: {
    id: string;
    organizationName: string | null;
    repoName: string | null;
    name: string | null;
    teamId: string;
  };
  /** Distinct edge kinds relating the two repos (e.g. `['code', 'build']`). */
  kinds: string[];
  /** Distinct provenance sources (`manual` | `manifest` | `git_signal` | `inferred`). */
  sources: string[];
  /** Highest confidence across the collapsed edges. */
  confidence: number;
  /** The active edge ids collapsed into this neighbour. */
  edgeIds: string[];
}

export interface RepoDependencyContext {
  /** Repos the subject depends on — forward walk, `from → to`. */
  upstream: RepoDependencyNeighbor[];
  /** Repos that depend on the subject — reverse walk, `to → from` (blast radius). */
  downstream: RepoDependencyNeighbor[];
}

export interface ResolveRepoDependencyCtx {
  /** The org the run/team belongs to; a neighbour outside it is never returned. */
  orgId: string;
}

interface EdgeRow {
  id: string;
  neighborId: string | null;
  kind: string;
  source: string;
  confidence: number;
}

const NEIGHBOR_SELECT = {
  id: true,
  name: true,
  organizationName: true,
  repoName: true,
  teamId: true,
} as const;

/**
 * Resolve the 1-hop dependency context for `repoId`.
 *
 * No-ops (returns empty) when `repoId` is absent — a generic/triggered run may
 * carry no connection, exactly like the `requireRepoId` guard, and dependency
 * context is a git-repo-run concern.
 */
export async function resolveRepoDependencyContext(
  prisma: Pick<PrismaClient, 'repoDependency' | 'connection'>,
  repoId: string | null | undefined,
  ctx: ResolveRepoDependencyCtx
): Promise<RepoDependencyContext> {
  if (!repoId) {
    return { downstream: [], upstream: [] };
  }

  // Edges are not tenant-scoped, so these read freely. Only `active` edges
  // participate — `proposed` / `dismissed` / `unresolved` are excluded by the
  // status filter, which is how the depended-upon team's dismiss veto and the
  // "proposals don't inject" rule take effect.
  const [upstreamEdges, downstreamEdges] = await Promise.all([
    prisma.repoDependency.findMany({
      select: { confidence: true, id: true, kind: true, source: true, toRepoId: true },
      where: { fromRepoId: repoId, status: 'active', toRepoId: { not: null } },
    }),
    prisma.repoDependency.findMany({
      select: { confidence: true, fromRepoId: true, id: true, kind: true, source: true },
      where: { status: 'active', toRepoId: repoId },
    }),
  ]);

  const upstreamRows: EdgeRow[] = upstreamEdges.map((e) => ({
    confidence: e.confidence,
    id: e.id,
    kind: e.kind,
    neighborId: e.toRepoId,
    source: e.source,
  }));
  const downstreamRows: EdgeRow[] = downstreamEdges.map((e) => ({
    confidence: e.confidence,
    id: e.id,
    kind: e.kind,
    neighborId: e.fromRepoId,
    source: e.source,
  }));

  const neighborIds = [
    ...new Set(
      [...upstreamRows, ...downstreamRows]
        .map((r) => r.neighborId)
        .filter((v): v is string => v !== null)
    ),
  ];
  if (neighborIds.length === 0) {
    return { downstream: [], upstream: [] };
  }

  // Hydrate neighbours filtered to the caller's org — the `team.orgId` predicate
  // is both the tenant-guard filter and the visibility boundary, so injection
  // never crosses an org even if a stray cross-org edge slipped past the write
  // path. Deactivated / non-git connections are dropped defensively.
  const neighbors = await prisma.connection.findMany({
    select: NEIGHBOR_SELECT,
    where: {
      id: { in: neighborIds },
      isActive: true,
      team: { orgId: ctx.orgId },
      type: 'git_repo',
    },
  });
  const byId = new Map(neighbors.map((n) => [n.id, n]));

  const collapse = (rows: EdgeRow[]): RepoDependencyNeighbor[] => {
    const groups = new Map<string, RepoDependencyNeighbor>();
    for (const row of rows) {
      if (!row.neighborId) {
        continue;
      }
      const repo = byId.get(row.neighborId);
      if (!repo) {
        continue; // outside the caller's org, inactive, or non-git — not visible
      }
      const existing = groups.get(row.neighborId);
      if (existing) {
        if (!existing.kinds.includes(row.kind)) {
          existing.kinds.push(row.kind);
        }
        if (!existing.sources.includes(row.source)) {
          existing.sources.push(row.source);
        }
        existing.confidence = Math.max(existing.confidence, row.confidence);
        existing.edgeIds.push(row.id);
      } else {
        groups.set(row.neighborId, {
          confidence: row.confidence,
          edgeIds: [row.id],
          kinds: [row.kind],
          repo,
          sources: [row.source],
        });
      }
    }
    return [...groups.values()];
  };

  return { downstream: collapse(downstreamRows), upstream: collapse(upstreamRows) };
}
