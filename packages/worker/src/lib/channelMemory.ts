import { prisma } from '@auto-swe/shared/db';
import { generateEmbeddingWithSpec } from './embeddings.js';
import { insertMemoryItem, searchMemoryItemsByVector } from './memoryStore.js';

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
  const channelRows = (await searchMemoryItemsByVector({
    limit,
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
  // and there is still room in the results after the channel query.
  if (scope.teamId && channelItems.length < limit) {
    const remaining = limit - channelItems.length;
    const channelIds = new Set(channelItems.map((i) => i.id));
    try {
      const teamRows = await searchTeamChannelMemory({
        excludeChannelId: scope.channelId,
        limit: remaining,
        queryText,
        similarityThreshold: Math.max(similarityThreshold, 0.75),
        teamId: scope.teamId,
      });
      for (const r of teamRows) {
        if (!channelIds.has(r.id)) {
          channelItems.push({ crossChannel: true, id: r.id, similarity: r.similarity, summary: r.summary });
        }
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
 * Raw SQL is required because pgvector operators aren't parameterisable and
 * `team_id != channel_id` isn't expressible via the single-column
 * `searchMemoryItemsByVector` helper.
 */
async function searchTeamChannelMemory(opts: {
  queryText: string;
  teamId: string;
  excludeChannelId: string;
  limit: number;
  similarityThreshold: number;
}): Promise<RetrievedChannelMemoryRow[]> {
  const { embedding: queryEmbedding, spec: embeddingSpec } = await generateEmbeddingWithSpec(
    opts.queryText
  );

  return prisma.$queryRawUnsafe<RetrievedChannelMemoryRow[]>(
    `SELECT
       id,
       lesson_summary AS "summary",
       1 - (embedding <=> $1::vector) AS similarity
     FROM memory_items
     WHERE team_id = $2::uuid
       AND channel_id IS NOT NULL
       AND channel_id != $3::uuid
       AND embedding IS NOT NULL
       AND consolidated_at IS NULL
       AND (embedding_model IS NULL OR embedding_model = $6)
       AND 1 - (embedding <=> $1::vector) >= $4
     ORDER BY embedding <=> $1::vector ASC
     LIMIT $5`,
    JSON.stringify(queryEmbedding),
    opts.teamId,
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
