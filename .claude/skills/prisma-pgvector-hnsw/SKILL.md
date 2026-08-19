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
3. **Non-expressible DDL belongs in `00000000000001`, not in the baseline.** The split is by *kind*
   of DDL, not by when it was written. While the schema is undeployed, add to that file and
   regenerate the baseline (`prisma migrate diff --from-empty --to-schema src/prisma/schema.prisma
   --script`) rather than appending a third migration — two migrations, one generated and one
   hand-written, is the shape to keep. **Once the schema is deployed anywhere this inverts:**
   `00000000000001` is then applied in the wild and must not be edited, so new DDL of either kind
   appends as its own migration.
4. **After regenerating the baseline, prove the result is unchanged.** Apply the old chain and the
   new one to two fresh databases and compare `information_schema.columns`, `pg_constraint` and
   `pg_indexes` — a raw `pg_dump` diff also reports physical column ordering, which is not a schema
   difference and will bury a real one.
5. **Embeddings are fixed at 1536 dimensions.** `packages/worker/src/lib/embeddings.ts` throws if a
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
