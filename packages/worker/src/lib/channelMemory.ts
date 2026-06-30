import { prisma } from '@auto-swe/shared/db';
import { generateEmbeddingWithSpec } from './embeddings.js';
import { insertMemoryItem, type QueryEmbedding, searchMemoryItemsByVector } from './memoryStore.js';

/** One retrieved channel-memory row with its cosine similarity to the query. */
export interface ChannelMemoryItem {
  id: string;
  summary: string;
  similarity: number;
  /** True when this item came from another channel in the same team (cross-channel). */
  crossChannel?: boolean;
}

interface RetrievedChannelMemoryRow {
  id: string;
  summary: string;
  similarity: number;
}

/**
 * Channel assistant (Phase 2 + Gap E). Retrieve channel-scoped memory rows that
 * are semantically similar to the current message, so the assistant can build
 * context over time. Mirrors `retrieveSimilarLessons` (repo-scoped) but scopes
 * to a single `channel_id` instead of a `repo_id`.
 *
 * When `scope.teamId` is provided (Gap E — workspace-level memory), ALSO
 * queries memory from OTHER channels in the same team (cross-channel context)
 * at a slightly higher similarity threshold so only strong matches from other
 * channels bleed in. Channel-specific items are listed first; cross-channel
 * items are appended after, labelled with `crossChannel: true`.
 *
 * Uses pgvector cosine distance (`<=>`) for ranking. Raw SQL is the one
 * sanctioned exception to the "no raw SQL" rule (Prisma doesn't support the
 * pgvector `<=>` operator).
 */
export async function retrieveChannelMemory(
  queryText: string,
  scope: { channelId: string; teamId?: string },
  limit = 5,
  similarityThreshold = 0.65
): Promise<ChannelMemoryItem[]> {
  // Embed the query ONCE and reuse the vector for both the channel-scoped and the
  // cross-channel team search — the text is identical, so a second embedding
  // round-trip on the reply hot path would be pure waste.
  const queryEmbedding = await generateEmbeddingWithSpec(queryText);

  const channelRows = (await searchMemoryItemsByVector({
    limit,
    precomputed: queryEmbedding,
    queryText,
    scopeColumn: 'channel_id',
    scopeId: scope.channelId,
    selectColumns: ['id', 'lesson_summary AS "summary"'],
    similarityThreshold,
  })) as unknown as RetrievedChannelMemoryRow[];

  const channelItems: ChannelMemoryItem[] = channelRows.map((r) => ({
    id: r.id,
    similarity: r.similarity,
    summary: r.summary,
  }));

  // Gap E: cross-channel (team-scoped) memory. Only run when teamId is known
  // and there is still room in the results after the channel query. The channel
  // query (channel_id = X) and the team query (channel_id != X) read disjoint
  // rows, so no de-dup is needed — they can never return the same item.
  if (scope.teamId && channelItems.length < limit) {
    try {
      const teamRows = await searchTeamChannelMemory({
        excludeChannelId: scope.channelId,
        limit: limit - channelItems.length,
        precomputed: queryEmbedding,
        similarityThreshold: Math.max(similarityThreshold, 0.75),
        teamId: scope.teamId,
      });
      for (const r of teamRows) {
        channelItems.push({
          crossChannel: true,
          id: r.id,
          similarity: r.similarity,
          summary: r.summary,
        });
      }
    } catch {
      // Cross-channel search is best-effort: a failure (e.g. no embedding)
      // should never block the channel-scoped reply.
    }
  }

  return channelItems;
}

/** One org-wide cross-channel memory hit, carrying its source channel for labelling. */
export interface OrgChannelMemoryItem {
  id: string;
  summary: string;
  similarity: number;
  sourceChannelId: string;
  sourceChannelName: string | null;
}

/**
 * Shared builder for the cross-channel pgvector search (Gap E team-scoped + Gap B
 * org-scoped). Both queries are identical except the scope column (`team_id` vs
 * `org_id`), optional extra SELECT columns, and an optional extra WHERE clause.
 *
 * Centralising the SQL here means the **Gap G privacy filter** (`sc.is_private =
 * false` — a private channel is never a cross-channel SOURCE) lives in exactly ONE
 * place, so a future cross-channel reader can't silently re-introduce the leak. The
 * `$1..$6` positional binding is also defined once: $1 embedding, $2 scopeId, $3
 * excludeChannelId, $4 similarityThreshold, $5 limit, $6 embeddingModel.
 *
 * Raw SQL is required (pgvector `<=>` isn't parameterisable; `scope != channel_id`
 * + the JOIN aren't expressible via the single-column `searchMemoryItemsByVector`).
 *
 * SAFETY: `extraSelect`/`extraWhere` are spliced into the query text, so they MUST
 * be literal constants (as both call sites below are) — never request/config/DB
 * input. All variable values flow through the `$1..$6` bindings, never the builder.
 * The result is computed once at module load (see the two consts below), so it is
 * never rebuilt per call.
 */
function crossChannelMemorySql(opts: {
  scopeColumn: 'team_id' | 'org_id';
  extraSelect?: string;
  extraWhere?: string;
}): string {
  const select = [
    'mi.id',
    'mi.lesson_summary AS "summary"',
    '1 - (mi.embedding <=> $1::vector) AS similarity',
  ]
    .concat(opts.extraSelect ?? [])
    .join(',\n       ');
  return `SELECT
       ${select}
     FROM memory_items mi
     JOIN slack_channels sc ON sc.id = mi.channel_id
     WHERE mi.${opts.scopeColumn} = $2::uuid
       AND mi.channel_id IS NOT NULL
       AND mi.channel_id != $3::uuid
       AND sc.is_private = false${opts.extraWhere ? `\n       ${opts.extraWhere}` : ''}
       AND mi.embedding IS NOT NULL
       AND mi.consolidated_at IS NULL
       AND (mi.embedding_model IS NULL OR mi.embedding_model = $6)
       AND 1 - (mi.embedding <=> $1::vector) >= $4
     ORDER BY mi.embedding <=> $1::vector ASC
     LIMIT $5`;
}

/** Team-scoped cross-channel SQL — built once (constant inputs). */
const TEAM_CROSS_CHANNEL_SQL = crossChannelMemorySql({ scopeColumn: 'team_id' });

/** Org-scoped cross-channel SQL (source-channel columns + active filter) — built once. */
const ORG_CROSS_CHANNEL_SQL = crossChannelMemorySql({
  extraSelect: ['sc.id   AS "sourceChannelId"', 'sc.name AS "sourceChannelName"'].join(
    ',\n       '
  ),
  extraWhere: 'AND sc.is_active = true',
  scopeColumn: 'org_id',
});

/** Run a {@link crossChannelMemorySql} query with the shared `$1..$6` binding. */
function runCrossChannelMemoryQuery<T>(
  sql: string,
  scopeId: string,
  opts: {
    excludeChannelId: string;
    limit: number;
    similarityThreshold: number;
    precomputed: QueryEmbedding;
  }
): Promise<T[]> {
  const { embedding: queryEmbedding, spec: embeddingSpec } = opts.precomputed;
  return prisma.$queryRawUnsafe<T[]>(
    sql,
    JSON.stringify(queryEmbedding),
    scopeId,
    opts.excludeChannelId,
    opts.similarityThreshold,
    opts.limit,
    embeddingSpec
  );
}

/**
 * Gap E: cross-channel memory search over OTHER channels in the same team (higher
 * threshold than the channel-scoped search so only strong matches bleed in). Gap G
 * privacy filter is applied by the shared {@link crossChannelMemorySql} builder.
 */
function searchTeamChannelMemory(opts: {
  teamId: string;
  excludeChannelId: string;
  limit: number;
  similarityThreshold: number;
  precomputed: QueryEmbedding;
}): Promise<RetrievedChannelMemoryRow[]> {
  return runCrossChannelMemoryQuery<RetrievedChannelMemoryRow>(
    TEAM_CROSS_CHANNEL_SQL,
    opts.teamId,
    opts
  );
}

/**
 * Gap B: org-wide cross-channel memory search over OTHER (non-private, active)
 * channels in the same org, returning the source channel id + name for
 * attribution. Privacy filter (Gap G) lives in the shared builder.
 */
export function searchOrgChannelMemory(opts: {
  orgId: string;
  excludeChannelId: string;
  limit: number;
  similarityThreshold: number;
  precomputed: QueryEmbedding;
}): Promise<OrgChannelMemoryItem[]> {
  return runCrossChannelMemoryQuery<OrgChannelMemoryItem>(ORG_CROSS_CHANNEL_SQL, opts.orgId, opts);
}

/** One recent (un-consolidated) channel-memory row, for ambient digest context. */
export interface RecentChannelMemoryItem {
  id: string;
  lessonSummary: string;
  rationale: string;
  createdAt: Date;
}

/**
 * Channel assistant (Phase 3). Fetch the most recent un-consolidated channel-memory
 * rows for the ambient digest — recency-ordered rather than similarity-ranked,
 * so the digest can surface forgotten / follow-up-worthy items.
 *
 * Scalar `select` only: the `embedding` column is a pgvector `Unsupported(...)`
 * type that Prisma cannot select, so it is deliberately excluded here (no raw
 * SQL needed because there is no vector operation).
 */
export async function recentChannelMemory(
  channelId: string,
  limit = 15
): Promise<RecentChannelMemoryItem[]> {
  return prisma.memoryItem.findMany({
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, id: true, lessonSummary: true, rationale: true },
    take: limit,
    where: { channelId, consolidatedAt: null },
  });
}

/**
 * Channel assistant (Phase 2). Persist one channel-scoped memory row with a vector
 * embedding for future semantic search. Mirrors `writeMemoryItemRow` from
 * `commitToMemory`, but for the channel case: `repo_id` is NULL while
 * `channel_id`/`team_id`/`org_id` are set.
 *
 * Returns the new row id. Callers wrap this best-effort (try/catch); it may
 * throw (embedding round-trip / DB failure) and that's fine.
 *
 * Raw SQL is used because Prisma doesn't support the pgvector column type.
 */
export async function writeChannelMemory(input: {
  channelId: string;
  teamId: string;
  orgId: string;
  summary: string;
  rationale: string;
  userSlackId?: string;
}): Promise<string> {
  const metadata = input.userSlackId ? { userSlackId: input.userSlackId } : {};

  return insertMemoryItem({
    agentKey: 'channelAssistant',
    channelId: input.channelId,
    lessonSummary: input.summary,
    metadata,
    orgId: input.orgId,
    rationale: input.rationale,
    scope: 'channel-memory',
    teamId: input.teamId,
  });
}
