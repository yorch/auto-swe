import { prisma } from '@auto-swe/shared/db';
import { generateEmbeddingWithSpec } from './embeddings.js';

/** One retrieved channel-memory row with its cosine similarity to the query. */
export interface ChannelMemoryItem {
  id: string;
  summary: string;
  similarity: number;
}

interface RetrievedChannelMemoryRow {
  id: string;
  summary: string;
  similarity: number;
}

/**
 * Claude Tag (Phase 2). Retrieve channel-scoped memory rows that are
 * semantically similar to the current message, so the assistant can build
 * context over time. Mirrors `retrieveSimilarLessons` (repo-scoped) but scopes
 * to a single `channel_id` instead of a `repo_id`.
 *
 * Uses pgvector cosine distance (`<=>`) for ranking — lower distance = higher
 * similarity. The `embedding_model` filter excludes rows produced with a
 * different embedding spec, so vectors are never compared across embedding
 * spaces after a model switch (EVOL-4).
 *
 * Raw SQL is used here because Prisma doesn't support pgvector operators — the
 * one sanctioned exception to the "no raw SQL" rule.
 */
export async function retrieveChannelMemory(
  queryText: string,
  scope: { channelId: string },
  limit = 5,
  similarityThreshold = 0.65
): Promise<ChannelMemoryItem[]> {
  const { embedding: queryEmbedding, spec: embeddingSpec } =
    await generateEmbeddingWithSpec(queryText);

  const rows = await prisma.$queryRawUnsafe<RetrievedChannelMemoryRow[]>(
    `SELECT
      id,
      lesson_summary AS "summary",
      1 - (embedding <=> $1::vector) AS similarity
    FROM memory_items
    WHERE channel_id = $2::uuid
      AND embedding IS NOT NULL
      AND consolidated_at IS NULL
      AND (embedding_model IS NULL OR embedding_model = $5)
      AND 1 - (embedding <=> $1::vector) >= $3
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $4`,
    JSON.stringify(queryEmbedding),
    scope.channelId,
    similarityThreshold,
    limit,
    embeddingSpec
  );

  return rows.map((r) => ({ id: r.id, similarity: r.similarity, summary: r.summary }));
}

/** One recent (un-consolidated) channel-memory row, for ambient digest context. */
export interface RecentChannelMemoryItem {
  id: string;
  lessonSummary: string;
  rationale: string;
  createdAt: Date;
}

/**
 * Claude Tag (Phase 3). Fetch the most recent un-consolidated channel-memory
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
 * Claude Tag (Phase 2). Persist one channel-scoped memory row with a vector
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
  const { embedding, spec } = await generateEmbeddingWithSpec(input.summary);
  const metadata = input.userSlackId ? { userSlackId: input.userSlackId } : {};

  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO memory_items
       (id, repo_id, channel_id, team_id, org_id, rationale, lesson_summary, embedding,
        embedding_model, scope, agent_key, metadata, created_at)
     VALUES
       (gen_random_uuid(), NULL, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::vector,
        $7, $8, $9, $10::jsonb, now())
     RETURNING id`,
    input.channelId,
    input.teamId,
    input.orgId,
    input.rationale,
    input.summary,
    JSON.stringify(embedding),
    spec,
    'channel-memory',
    'channelAssistant',
    JSON.stringify(metadata)
  );

  return rows[0]?.id ?? '';
}
