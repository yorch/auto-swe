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

/**
 * The neighbour repo columns both the resolver and the management API surface.
 * Shared so the two views agree on the shape.
 *
 * The visibility *predicate* (`isActive` + `team.orgId` + git_repo) is
 * deliberately NOT extracted into a shared helper: `tenantGuard.coverage.test.ts`
 * statically requires a literal `team.orgId` at every `connection.findMany` site,
 * and a spread helper hides it from that guard. So each call site inlines the
 * same where clause — kept honest by the tenant-guard test, not by DRY.
 */
export const NEIGHBOR_SELECT = {
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

  const neighborIds = [
    ...new Set([
      ...upstreamEdges.map((e) => e.toRepoId).filter((v): v is string => v !== null),
      ...downstreamEdges.map((e) => e.fromRepoId),
    ]),
  ];
  if (neighborIds.length === 0) {
    return { downstream: [], upstream: [] };
  }

  // Hydrate neighbours filtered to the caller's org — the `team.orgId` predicate
  // is both the tenant-guard filter and the visibility boundary, so injection
  // never crosses an org even if a stray cross-org edge slipped past the write
  // path. Deactivated / non-git connections are dropped defensively. (Mirrored in
  // the GET management route; kept literal per tenantGuard.coverage.test.ts.)
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

  type RawEdge = { id: string; kind: string; source: string; confidence: number };
  const collapse = <E extends RawEdge>(
    edges: E[],
    neighborIdOf: (e: E) => string | null
  ): RepoDependencyNeighbor[] => {
    const groups = new Map<string, RepoDependencyNeighbor>();
    for (const e of edges) {
      const nid = neighborIdOf(e);
      const repo = nid ? byId.get(nid) : undefined;
      if (!nid || !repo) {
        continue; // outside the caller's org, inactive, or non-git — not visible
      }
      const existing = groups.get(nid);
      if (existing) {
        if (!existing.kinds.includes(e.kind)) {
          existing.kinds.push(e.kind);
        }
        if (!existing.sources.includes(e.source)) {
          existing.sources.push(e.source);
        }
        existing.confidence = Math.max(existing.confidence, e.confidence);
        existing.edgeIds.push(e.id);
      } else {
        groups.set(nid, {
          confidence: e.confidence,
          edgeIds: [e.id],
          kinds: [e.kind],
          repo,
          sources: [e.source],
        });
      }
    }
    return [...groups.values()];
  };

  return {
    downstream: collapse(downstreamEdges, (e) => e.fromRepoId),
    upstream: collapse(upstreamEdges, (e) => e.toRepoId),
  };
}
