import type { ModelBackedAgentKey } from '@auto-swe/shared/agentKeys';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { EDGE_KINDS } from '@auto-swe/shared/lib/repoDependency';
import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { runAgent } from './runAgent.js';

/**
 * P3 repo-dependency-graph: an LLM proposes likely cross-repo edges from repo
 * metadata (name, description, language, declared package names). Every
 * candidate the model may reference is the subject repo's own org — no
 * cross-tenant leakage, no invented repos. Writes land as `source:'inferred'`,
 * `status:'proposed'` edges for a human to confirm/dismiss via the existing
 * PATCH `/dependencies/:edgeId` route (see `docs/history/repo-dependency-graph-rfc.md`),
 * unless the model's confidence clears the operator-tunable auto-promote
 * threshold, in which case the edge is written straight to `active`.
 *
 * The read-side resolver (`repoDependencyResolver.ts`) only walks `active`
 * edges, so a `proposed` row is invisible to agent context until promoted —
 * this activity cannot leak an unconfirmed LLM guess into another run's
 * prompt.
 */

// ── Zod schema for structured output ──
//
// Deliberately loose (no `.min/.max` on confidence, no `z.enum` on kind): a
// stricter schema would make Mastra reject the whole completion the moment
// one edge is out of range, where the real requirement is narrower — drop
// just the bad edges and keep the rest. Validation happens by hand below.
const InferredEdgeSchema = z.object({
  confidence: z.number(),
  kind: z.string(),
  rationale: z.string(),
  toRepoId: z.string(),
});

const InferenceOutputSchema = z.object({
  edges: z.array(InferredEdgeSchema),
});

type InferenceOutput = z.infer<typeof InferenceOutputSchema>;
type InferredEdge = z.infer<typeof InferredEdgeSchema>;

export interface InferRepoDependenciesInput {
  repoId: string;
}

export interface InferRepoDependenciesResult {
  /** New edges written as `status:'proposed'` this run. */
  proposed: number;
  /** New edges written straight to `status:'active'` (confidence ≥ threshold). */
  autoPromoted: number;
}

/** Hard cap on edges accepted from one inference call, regardless of what the model returns. */
const MAX_INFERRED_EDGES = 20;

/** `org/repo` when both halves are known, else the bare repo name or id. */
function repoLabel(c: {
  organizationName: string | null;
  repoName: string | null;
  id: string;
}): string {
  if (c.organizationName && c.repoName) {
    return `${c.organizationName}/${c.repoName}`;
  }
  return c.repoName ?? c.id;
}

const EDGE_KIND_SET: ReadonlySet<string> = new Set(EDGE_KINDS);

/** Candidate membership, self-edge, confidence range, kind — never trusts the model's output. */
function acceptEdges(
  rawEdges: InferredEdge[],
  subjectId: string,
  candidateIds: Set<string>
): InferredEdge[] {
  return rawEdges
    .filter((e) => candidateIds.has(e.toRepoId))
    .filter((e) => e.toRepoId !== subjectId)
    .filter((e) => Number.isFinite(e.confidence) && e.confidence >= 0 && e.confidence <= 1)
    .filter((e) => EDGE_KIND_SET.has(e.kind))
    .slice(0, MAX_INFERRED_EDGES);
}

type UpsertOutcome = 'proposed' | 'active' | 'skipped';

/**
 * Create-or-refresh a `RepoDependency` row on its natural key
 * (fromRepoId, toRepoId, kind, source='inferred'). Prisma cannot `upsert` on
 * a partial unique index, so this is `findFirst` + conditional
 * `create`/`update` — mirrors `detectRepoDependencies.ts`'s `upsertEdge`.
 *
 * A `dismissed` edge is a sticky human veto: found-but-dismissed returns
 * `'skipped'` without writing anything, so a re-run can never resurrect or
 * overwrite it. An edge that already exists and is not dismissed only has its
 * `confidence`/`detail` refreshed — its `status` is never touched once
 * created, so a human confirm/dismiss decision (or a prior auto-promotion)
 * is never clobbered by a later inference pass.
 */
async function upsertInferredEdge(
  fromRepoId: string,
  edge: InferredEdge,
  threshold: number,
  allowAutoPromote: boolean
): Promise<UpsertOutcome> {
  const existing = await prisma.repoDependency.findFirst({
    where: {
      fromRepoId,
      kind: edge.kind,
      source: 'inferred',
      toRepoId: edge.toRepoId,
    },
  });

  if (existing) {
    if (existing.status === 'dismissed') {
      return 'skipped';
    }
    await prisma.repoDependency.update({
      data: {
        confidence: edge.confidence,
        detail: { rationale: edge.rationale } as never,
      },
      where: { id: existing.id },
    });
    return 'skipped';
  }

  // Auto-promotion skips the human confirm, so it may only skip a confirmation
  // that was this team's to give. A cross-team edge still needs the both-teams
  // consent the API enforces, and stays `proposed` however confident the model is.
  const autoPromote = allowAutoPromote && edge.confidence >= threshold;
  await prisma.repoDependency.create({
    data: {
      confidence: edge.confidence,
      // Deliberately no `confirmedAt`: nobody confirmed this. Every other write
      // path sets `confirmedAt` and `confirmedById` together, and stamping a
      // time with no confirmer would make an unreviewed edge read as approved.
      detail: {
        rationale: edge.rationale,
        ...(autoPromote ? { autoPromoted: true } : {}),
      } as never,
      fromRepoId,
      kind: edge.kind,
      source: 'inferred',
      status: autoPromote ? 'active' : 'proposed',
      toRepoId: edge.toRepoId,
    },
  });
  return autoPromote ? 'active' : 'proposed';
}

/**
 * Infer likely dependency edges for `repoId` against every other active
 * git_repo Connection in its own org, and write the surviving proposals.
 *
 * Not an LLM proof-migration path with graceful degradation like
 * `validateContext` — a resolution or generation failure propagates so
 * Temporal retries the activity, matching `detectRepoDependencies.ts`'s
 * non-LLM sibling. Only the advisory rationale scan is best-effort.
 */
export async function inferRepoDependencies(
  input: InferRepoDependenciesInput
): Promise<InferRepoDependenciesResult> {
  const empty: InferRepoDependenciesResult = { autoPromoted: 0, proposed: 0 };

  const connection = await prisma.connection.findUnique({
    select: {
      description: true,
      id: true,
      isActive: true,
      language: true,
      organizationName: true,
      packageNames: true,
      repoName: true,
      team: { select: { orgId: true } },
      teamId: true,
      type: true,
    },
    where: { id: input.repoId },
  });

  if (!connection || connection.type !== 'git_repo' || !connection.isActive || !connection.team) {
    return empty;
  }
  const orgId = connection.team.orgId;

  // Candidate repos this inference may reference: active git_repo connections
  // in the same tenant org, excluding the subject itself. Literal
  // `team: { orgId }` predicate required by tenantGuard.coverage.test.ts — do
  // not extract into a helper or spread it in.
  const candidateRows = await prisma.connection.findMany({
    select: {
      description: true,
      id: true,
      language: true,
      organizationName: true,
      packageNames: true,
      repoName: true,
      teamId: true,
    },
    where: { id: { not: connection.id }, isActive: true, team: { orgId }, type: 'git_repo' },
  });

  if (candidateRows.length === 0) {
    return empty;
  }
  const candidateIds = new Set(candidateRows.map((c) => c.id));

  const ctx = await currentRequestContext();
  const spec = await resolveAgentSpec(
    {
      agentKey: 'repoDependencyInferrer' as ModelBackedAgentKey,
      outputSchema: InferenceOutputSchema,
    },
    ctx
  );

  const userMessage = JSON.stringify({
    candidates: candidateRows.map((c) => ({
      description: c.description,
      id: c.id,
      language: c.language,
      packageNames: c.packageNames,
      repo: repoLabel(c),
    })),
    subjectRepo: {
      description: connection.description,
      language: connection.language,
      packageNames: connection.packageNames,
      repo: repoLabel(connection),
    },
  });

  const tracer = new AgentTracer();
  try {
    const result = await runAgent<InferenceOutput>(spec, userMessage, {
      spanName: 'llm.repo_dependency_inference',
    });
    const rawEdges = result.object?.edges ?? [];

    // Advisory scan of the model's free-text rationale — non-blocking; mirrors
    // implementerSession.ts's post-generate output scan. A DB failure here
    // must not abort the activity.
    const rationaleText = rawEdges
      .map((e) => e.rationale)
      .filter((r): r is string => !!r)
      .join('\n');
    if (rationaleText) {
      try {
        const scan = await scanSkillContent(rationaleText);
        if (!scan.safe) {
          tracer.addActivityEvent({
            name: 'repoDependency.suspicious_inference',
            outputJson: { warnings: scan.warnings },
          });
        }
      } catch {
        // Scan failure is non-fatal — inference still proceeds.
      }
    }

    const accepted = acceptEdges(rawEdges, connection.id, candidateIds);
    const threshold = await resolveSetting('repoDependency.autoPromoteThreshold', ctx);
    const sameTeam = new Set(
      candidateRows.filter((c) => c.teamId === connection.teamId).map((c) => c.id)
    );

    let proposed = 0;
    let autoPromoted = 0;
    for (const edge of accepted) {
      const outcome = await upsertInferredEdge(
        connection.id,
        edge,
        threshold,
        sameTeam.has(edge.toRepoId)
      );
      if (outcome === 'proposed') {
        proposed++;
      } else if (outcome === 'active') {
        autoPromoted++;
      }
    }

    return { autoPromoted, proposed };
  } finally {
    await persistActivityTrace(tracer, 'repoDependencyInferrer');
  }
}
