-- Add HNSW index for agent_lessons embedding similarity search
-- This enables efficient cosine similarity queries on the embedding column
CREATE INDEX IF NOT EXISTS idx_agent_lessons_embedding
  ON agent_lessons
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
