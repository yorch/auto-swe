---
name: prisma-pgvector-hnsw
description: Handle the pgvector HNSW index and other non-Prisma-expressible DDL when changing schema.prisma or adding a migration. Use when a migration diff unexpectedly drops idx_memory_items_embedding, a CHECK constraint, or a partial unique index, or before running any prisma migrate command in this repo.
---

# pgvector, HNSW, and DDL Prisma cannot express

`memory_items.embedding` is `vector(1536)` with an HNSW index. Prisma's DSL cannot express that
index — nor the CHECK constraints, partial unique indexes, or array `NOT NULL`s this schema relies
on. They live in a hand-written migration:

```
packages/shared/src/prisma/migrations/
├── 00000000000000_init/                        generated baseline
└── 00000000000001_custom_constraints_and_indexes/   hand-written DDL
```

## The gotcha

`prisma migrate dev` diffs the database against `schema.prisma`. Everything in the hand-written
migration is invisible to the schema, so the diff reads it as drift and **emits a DROP** — every
time, for any unrelated schema change.

```sql
-- what `migrate dev` silently proposes, on a migration that has nothing to do with memory:
DROP INDEX "idx_memory_items_embedding";
```

Applied to production, that drops the index semantic memory retrieval depends on. Queries keep
working — they fall back to a sequential scan — so nothing fails loudly. Recall degrades and
latency climbs.

## Rules

1. **Never run `prisma migrate dev` against production.** Use `prisma migrate deploy`, which applies
   pending migrations verbatim and diffs nothing.
2. **Read every generated migration before committing it.** If it contains a `DROP INDEX`,
   `DROP CONSTRAINT`, or `ALTER … DROP NOT NULL` you did not intend, delete those statements. The
   generator does not know the DDL it is dropping was deliberate.
3. **New non-expressible DDL goes in its own hand-written migration**, appended after the existing
   two — never by editing `00000000000001`, which is already applied everywhere.
4. **Embeddings are fixed at 1536 dimensions.** `packages/worker/src/lib/embeddings.ts` throws if a
   model returns a different shape; changing the dimension means a new migration plus a re-embed of
   every existing row.

## Resetting locally

```bash
yarn workspace @auto-swe/shared exec prisma migrate reset
```

This replays both migrations from empty, so the hand-written DDL comes back. It is the cleanest way
to recover a local database that a stray `migrate dev` has already stripped.

## Rebuilding the index

```sql
REINDEX INDEX idx_memory_items_embedding;
```

Needed only after a bulk import, or if recall degrades — not as routine maintenance.
