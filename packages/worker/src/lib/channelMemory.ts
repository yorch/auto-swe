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

/**
 * Gap E: cross-channel memory search. Queries memory items belonging to OTHER
 * channels in the same team (same `team_id`, different `channel_id`) so the
 * assistant can surface relevant knowledge from sibling channels in the org.
 *
 * Uses a slightly higher threshold than the channel-scoped search to ensure
 * only strongly-matching cross-channel items appear (reducing noise).
 *
 * Gap G ("does not report from private channels"): a private SOURCE channel's
 * memory must never bleed into another channel. We JOIN `slack_channels` and
 * exclude rows whose owning channel has `is_private = true`, so a private
 * channel's facts stay inside that channel even though they share a team. (The
 * reading channel's OWN memory is fetched by the separate `channel_id = X` query
 * and is unaffected — a private channel still uses its own memory normally.)
 *
 * Raw SQL is required because pgvector operators aren't parameterisable and
 * `team_id != channel_id` isn't expressible via the single-column
 * `searchMemoryItemsByVector` helper. Takes a pre-computed query embedding so the
 * caller embeds the query text once across both searches.
 */
async function searchTeamChannelMemory(opts: {
  teamId: string;
  excludeChannelId: string;
  limit: number;
  similarityThreshold: number;
  precomputed: QueryEmbedding;
}): Promise<RetrievedChannelMemoryRow[]> {
  const { embedding: queryEmbedding, spec: embeddingSpec } = opts.precomputed;

  return prisma.$queryRawUnsafe<RetrievedChannelMemoryRow[]>(
    `SELECT
       mi.id,
       mi.lesson_summary AS "summary",
       1 - (mi.embedding <=> $1::vector) AS similarity
     FROM memory_items mi
     JOIN slack_channels sc ON sc.id = mi.channel_id
     WHERE mi.team_id = $2::uuid
       AND mi.channel_id IS NOT NULL
       AND mi.channel_id != $3::uuid
       AND sc.is_private = false
       AND mi.embedding IS NOT NULL
       AND mi.consolidated_at IS NULL
       AND (mi.embedding_model IS NULL OR mi.embedding_model = $6)
       AND 1 - (mi.embedding <=> $1::vector) >= $4
     ORDER BY mi.embedding <=> $1::vector ASC
     LIMIT $5`,
    JSON.stringify(queryEmbedding),
    opts.teamId,
    opts.excludeChannelId,
    opts.similarityThreshold,
    opts.limit,
    embeddingSpec
  );
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
 * Gap B: org-wide cross-channel memory search. Queries memory items from OTHER
 * channels in the same ORG (`org_id = X`, `channel_id != current`) so the ambient
 * org-flagging pass can surface notable activity from across the organization.
 *
 * Privacy (Gap G): JOINs `slack_channels` and excludes `is_private = true` source
 * channels — a private channel's facts are never flagged into another channel,
 * exactly as the team-scoped {@link searchTeamChannelMemory} does. Also excludes
 * inactive source channels. Returns the source channel id + name for attribution.
 *
 * Raw SQL is required for the pgvector `<=>` operator + the cross-row JOIN. Embeds
 * the query text once (caller passes a precomputed embedding).
 */
export async function searchOrgChannelMemory(opts: {
  orgId: string;
  excludeChannelId: string;
  limit: number;
  similarityThreshold: number;
  precomputed: QueryEmbedding;
}): Promise<OrgChannelMemoryItem[]> {
  const { embedding: queryEmbedding, spec: embeddingSpec } = opts.precomputed;

  return prisma.$queryRawUnsafe<OrgChannelMemoryItem[]>(
    `SELECT
       mi.id,
       mi.lesson_summary AS "summary",
       1 - (mi.embedding <=> $1::vector) AS similarity,
       sc.id   AS "sourceChannelId",
       sc.name AS "sourceChannelName"
     FROM memory_items mi
     JOIN slack_channels sc ON sc.id = mi.channel_id
     WHERE mi.org_id = $2::uuid
       AND mi.channel_id IS NOT NULL
       AND mi.channel_id != $3::uuid
       AND sc.is_private = false
       AND sc.is_active = true
       AND mi.embedding IS NOT NULL
       AND mi.consolidated_at IS NULL
       AND (mi.embedding_model IS NULL OR mi.embedding_model = $6)
       AND 1 - (mi.embedding <=> $1::vector) >= $4
     ORDER BY mi.embedding <=> $1::vector ASC
     LIMIT $5`,
    JSON.stringify(queryEmbedding),
    opts.orgId,
    opts.excludeChannelId,
    opts.similarityThreshold,
    opts.limit,
    embeddingSpec
  );
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
