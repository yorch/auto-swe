-- EVOL-4: record which embedding model produced each lesson vector so
-- retrieval/consolidation never compare vectors across embedding spaces
-- after a model switch. Null = legacy rows written before tracking.
ALTER TABLE "agent_lessons" ADD COLUMN "embedding_model" TEXT;
