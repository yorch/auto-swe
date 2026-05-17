-- Re-add the pgvector HNSW index that 20260517215425_add_better_auth_tables
-- inadvertently dropped. Prisma 7's `migrate dev` cannot see HNSW indexes
-- (the schema DSL doesn't model them) so it diffs them as "remove" on every
-- run that has unrelated schema changes — see the
-- `prisma-7-pgvector-hnsw-migrate-dev-drift` skill for the workflow.

CREATE INDEX IF NOT EXISTS "idx_agent_lessons_embedding" ON "agent_lessons"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);
