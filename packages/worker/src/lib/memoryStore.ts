import { prisma } from '@auto-swe/shared/db';
import { generateEmbeddingWithSpec } from './embeddings.js';

/**
 * Shared pgvector helpers for the `memory_items` table.
 *
 * Two flows write/read this table with near-identical SQL: the SWE lesson flow
 * (`commitToMemory` / `lessonRetrieval`, scoped by `repo_id`) and the channel-assistant
 * channel-memory flow (`channelMemory`, scoped by `channel_id`). This module is
 * the single source of truth for the cosine-similarity SELECT and the row
 * INSERT, so the two callers can't drift.
 *
 * Raw SQL via `$queryRawUnsafe` is the one sanctioned exception to the
 * "no raw SQL" rule — Prisma does not support the pgvector `<=>` operator or
 * the `vector` column type.
 */

/**
 * Allowlist of scope columns that {@link searchMemoryItemsByVector} may
 * interpolate into the WHERE clause. SECURITY: the scope column name is the one
 * value that ends up *inside* the SQL string (it cannot be a bind parameter — a
 * column identifier is not parameterizable), so it must come exclusively from a
 * hardcoded literal supplied by the caller. We assert membership here so that
 * even a future caller mistake can never let user input reach the interpolation.
 */
const ALLOWED_SCOPE_COLUMNS = ['repo_id', 'channel_id'] as const;
type ScopeColumn = (typeof ALLOWED_SCOPE_COLUMNS)[number];

/**
 * A pre-computed query embedding plus the spec it was produced under. Produced by
 * {@link generateEmbeddingWithSpec} and passed as `precomputed` to
 * {@link searchMemoryItemsByVector} (and `searchTeamChannelMemory`) so a caller
 * that fans the SAME query text across multiple vector searches (e.g. channel +
 * cross-channel team memory) embeds it once, not once per search.
 */
export interface QueryEmbedding {
  embedding: number[];
  spec: string;
}

function assertScopeColumn(column: string): asserts column is ScopeColumn {
  if (!(ALLOWED_SCOPE_COLUMNS as readonly string[]).includes(column)) {
    throw new Error(
      `searchMemoryItemsByVector: illegal scopeColumn '${column}'. ` +
        `Only ${ALLOWED_SCOPE_COLUMNS.join(', ')} are permitted (hardcoded by callers).`
    );
  }
}

/**
 * Cosine-similarity search over `memory_items`, scoped to a single owning row
 * (`repo_id` or `channel_id`). Embeds `queryText`, then ranks by pgvector cosine
 * distance (`<=>`) — lower distance = higher similarity. Rows are filtered to
 * those with an embedding, not yet consolidated, and produced under the current
 * embedding spec (or with a null spec, for pre-tracking rows) so vectors are
 * never compared across embedding spaces after a model switch (EVOL-4).
 *
 * SECURITY: `scopeColumn` and every entry of `selectColumns` are interpolated
 * into the SQL string and so MUST be hardcoded literals/allowlisted values at
 * the call site — never user input. `scopeColumn` is additionally checked
 * against {@link ALLOWED_SCOPE_COLUMNS}. The runtime values (`scopeId`,
 * embedding, threshold, limit, spec) are passed as bind parameters.
 *
 * Returns the raw row objects (shaped by the `AS` aliases the caller supplies in
 * `selectColumns`); callers map them to their public shapes.
 */
export async function searchMemoryItemsByVector(opts: {
  queryText: string;
  scopeColumn: 'repo_id' | 'channel_id';
  scopeId: string;
  /** SELECT projection expressions (with their `AS` aliases) the caller wants
   *  back, e.g. `'lesson_summary AS "lessonSummary"'`. The shared
   *  `1 - (embedding <=> $1::vector) AS similarity` column is always appended. */
  selectColumns: string[];
  limit: number;
  similarityThreshold: number;
  /** Optional pre-computed query embedding. When a caller runs several searches
   *  for the SAME `queryText` (e.g. channel + cross-channel team memory), it can
   *  embed once via {@link embedQuery} and pass the result here to avoid a
   *  redundant embedding round-trip per search. */
  precomputed?: QueryEmbedding;
}): Promise<Record<string, unknown>[]> {
  assertScopeColumn(opts.scopeColumn);

  const { embedding: queryEmbedding, spec: embeddingSpec } =
    opts.precomputed ?? (await generateEmbeddingWithSpec(opts.queryText));

  const projection = [...opts.selectColumns, '1 - (embedding <=> $1::vector) AS similarity'].join(
    ',\n      '
  );

  return prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT
      ${projection}
    FROM memory_items
    WHERE ${opts.scopeColumn} = $2::uuid
      AND embedding IS NOT NULL
      AND consolidated_at IS NULL
      AND (embedding_model IS NULL OR embedding_model = $5)
      AND 1 - (embedding <=> $1::vector) >= $3
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $4`,
    JSON.stringify(queryEmbedding),
    opts.scopeId,
    opts.similarityThreshold,
    opts.limit,
    embeddingSpec
  );
}

/**
 * Entity-scoped cosine-similarity search over `memory_items`. This is the generic
 * counterpart to {@link searchMemoryItemsByVector}: instead of hardcoding a
 * `repo_id` or `channel_id` scope column, callers pass an `entityType`/
 * `entityId` pair that the platform uses for cross-domain memory retrieval.
 *
 * `entityType` is a hardcoded literal from {@link MemoryEntityType} and is
 * interpolated into the SQL as a column filter (not a bind parameter). It is
 * validated against the allowlist before execution.
 */
export async function searchMemoryItemsByEntity(opts: {
  queryText: string;
  entityType: MemoryEntityType;
  entityId: string;
  selectColumns: string[];
  limit: number;
  similarityThreshold: number;
  precomputed?: QueryEmbedding;
}): Promise<Record<string, unknown>[]> {
  const { embedding: queryEmbedding, spec: embeddingSpec } =
    opts.precomputed ?? (await generateEmbeddingWithSpec(opts.queryText));

  const projection = [...opts.selectColumns, '1 - (embedding <=> $1::vector) AS similarity'].join(
    ',\n      '
  );

  return prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT
      ${projection}
    FROM memory_items
    WHERE entity_type = $2
      AND entity_id = $3
      AND embedding IS NOT NULL
      AND consolidated_at IS NULL
      AND (embedding_model IS NULL OR embedding_model = $6)
      AND 1 - (embedding <=> $1::vector) >= $4
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $5`,
    JSON.stringify(queryEmbedding),
    opts.entityType,
    opts.entityId,
    opts.similarityThreshold,
    opts.limit,
    embeddingSpec
  );
}

/**
 * Insert one `memory_items` row with a vector embedding for the `lessonSummary`
 * text, RETURNING its id. Every scope column (`repo_id`, `channel_id`, `team_id`,
 * `org_id`, …) is nullable, so a single statement serves both the repo-scoped
 * SWE lesson flow and the channel-scoped channel-assistant flow without behavior change:
 * each caller supplies exactly the columns it sets and leaves the rest null.
 *
 * `scope` defaults to `'swe-lessons'` (matching the DB column default) when the
 * caller omits it; `metadata` defaults to `{}` and `skillsActive` to `[]`,
 * mirroring the two original inserts byte-for-byte.
 */
export type MemoryEntityType = 'connection' | 'channel' | 'document' | 'project' | 'record';

export async function insertMemoryItem(input: {
  repoId?: string | null;
  channelId?: string | null;
  teamId?: string | null;
  orgId?: string | null;
  workflowId?: string | null;
  workflowRunId?: string | null;
  agentKey?: string | null;
  model?: string | null;
  costUsd?: number | null;
  scope?: string;
  rationale: string;
  lessonSummary: string;
  failureType?: string | null;
  metadata?: Record<string, unknown> | null;
  skillsActive?: string[];
  entityType?: MemoryEntityType | null;
  entityId?: string | null;
}): Promise<string> {
  const { embedding, spec } = await generateEmbeddingWithSpec(input.lessonSummary);

  // For callers that have not yet adopted explicit entity scoping, derive the
  // entity pair from the legacy repo/channel columns so retrieval by entity
  // works for existing flows without forcing every call site to change.
  const entityType =
    input.entityType ??
    (input.repoId != null ? 'connection' : input.channelId != null ? 'channel' : null);
  const entityId = input.entityId ?? input.repoId ?? input.channelId ?? null;

  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO memory_items
       (id, workflow_id, repo_id, channel_id, team_id, org_id, rationale, lesson_summary,
        embedding, embedding_model, failure_type, scope, metadata, skills_active,
        workflow_run_id, agent_key, model, cost_usd, entity_type, entity_id, created_at)
     VALUES
       (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7,
        $8::vector, $9, $10, $11, $12::jsonb, $13::text[],
        $14::uuid, $15, $16, $17, $18, $19, now())
     RETURNING id`,
    input.workflowId ?? null,
    input.repoId ?? null,
    input.channelId ?? null,
    input.teamId ?? null,
    input.orgId ?? null,
    input.rationale,
    input.lessonSummary,
    JSON.stringify(embedding),
    spec,
    input.failureType ?? null,
    input.scope ?? 'swe-lessons',
    JSON.stringify(input.metadata ?? {}),
    input.skillsActive ?? [],
    input.workflowRunId ?? null,
    input.agentKey ?? null,
    input.model ?? null,
    input.costUsd ?? null,
    entityType,
    entityId
  );

  return rows[0]?.id ?? '';
}

/**
 * Re-embed a single `memory_items` row from its CURRENT `lesson_summary`.
 *
 * When an admin edits a channel memory item's text (the gateway updates
 * `lesson_summary` / `rationale` synchronously), the stored pgvector `embedding`
 * goes stale — retrieval would still match on the OLD text. This regenerates the
 * embedding for the row's present summary and records the embedding spec
 * alongside it (so the EVOL-4 cross-space guard in {@link searchMemoryItemsByVector}
 * keeps working).
 *
 * Reads only scalar columns — NEVER the `embedding` (pgvector `Unsupported`)
 * column, which Prisma can't project. Returns `false` (no throw) when the row
 * doesn't exist so callers can treat a deleted row as a no-op.
 *
 * Raw SQL is the sanctioned pgvector exception here, same as the rest of this
 * module.
 */
export async function reembedMemoryItem(memoryId: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ lessonSummary: string }[]>(
    `SELECT lesson_summary AS "lessonSummary"
     FROM memory_items
     WHERE id = $1::uuid`,
    memoryId
  );

  const lessonSummary = rows[0]?.lessonSummary;
  if (lessonSummary === undefined) {
    return false;
  }

  const { embedding, spec } = await generateEmbeddingWithSpec(lessonSummary);

  await prisma.$executeRawUnsafe(
    `UPDATE memory_items
     SET embedding = $1::vector, embedding_model = $2
     WHERE id = $3::uuid`,
    JSON.stringify(embedding),
    spec,
    memoryId
  );

  return true;
}
