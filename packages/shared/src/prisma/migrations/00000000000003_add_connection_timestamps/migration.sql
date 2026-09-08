-- ----------------------------------------------------------------------------
-- `connections` gets created_at / updated_at.
--
-- It was one of the few models without them (39 of 61 carry created_at), and
-- their absence had a concrete cost: when the `executor_image` column default
-- was dropped, there was no way to tell a value an operator had chosen from one
-- the default had written, so the migration that released those rows had to
-- clear both. Timestamps make the next question of that shape decidable.
--
-- Existing rows are backfilled with the migration's own timestamp, which is the
-- only value available — it records when the column appeared, not when the
-- connection was created. Do not read created_at on a pre-existing row as
-- creation time.
--
-- Appended rather than folded into the generated baseline: 00000000000002 is a
-- data fix-up that only means anything against live rows, so the schema is
-- deployed, and rewriting the baseline would rewrite history already applied.
--
-- NOTE: `prisma migrate diff` generated this and also proposed
--   DROP INDEX "idx_memory_items_embedding";
-- which is removed here. The DSL cannot express the pgvector HNSW index, so the
-- generator reads it as drift on every unrelated schema change and offers to
-- drop it. Dropping it does not fail loudly — queries fall back to a sequential
-- scan and recall quietly degrades. See the prisma-pgvector-hnsw skill.
-- ----------------------------------------------------------------------------

ALTER TABLE "connections"
  ADD COLUMN "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
