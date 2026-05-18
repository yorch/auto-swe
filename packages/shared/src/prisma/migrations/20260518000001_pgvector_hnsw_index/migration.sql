-- Raw pgvector HNSW index on agent_lessons.embedding. Prisma 7's schema DSL
-- cannot model HNSW/IVFFlat indexes, so it lives in its own migration kept
-- separate from `init`. Routine application is `yarn db:migrate` (deploy);
-- `prisma migrate dev` cannot see HNSW indexes and will try to re-drop this
-- one on the next unrelated schema change — see the project skill
-- `prisma-7-pgvector-hnsw-migrate-dev-drift` for the workflow.

CREATE INDEX IF NOT EXISTS "idx_agent_lessons_embedding" ON "agent_lessons"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);
