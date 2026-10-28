-- Hand-written DDL (see the prisma-pgvector-hnsw skill): Prisma's schema DSL cannot declare a
-- partial index, and the diff does not model one, so it is neither in schema.prisma nor
-- reported as drift.
--
-- The pending-artifact sweep (pruneAgentTranscripts) selects
-- `status = 'pending' AND created_at < cutoff ORDER BY id` on every run. Pending rows are
-- transient and almost always absent, so a partial index keeps that lookup off a sequential
-- scan of every artifact while costing nothing on the common `ready` write path.
CREATE INDEX IF NOT EXISTS workflow_artifacts_pending_created_at_idx
  ON workflow_artifacts (created_at)
  WHERE status = 'pending';
