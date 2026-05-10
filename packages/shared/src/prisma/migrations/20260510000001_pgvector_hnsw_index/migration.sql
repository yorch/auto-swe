-- Raw pgvector index. Prisma's schema DSL cannot model HNSW/IVFFlat indexes,
-- so this migration lives outside what `prisma migrate dev` can regenerate.
-- See packages/shared/src/prisma/schema.prisma (model AgentLesson) for the
-- rationale and the recommended workflow (use `yarn db:migrate`, not
-- `yarn db:migrate:dev`, for routine application).

CREATE INDEX "idx_agent_lessons_embedding" ON "agent_lessons"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);
