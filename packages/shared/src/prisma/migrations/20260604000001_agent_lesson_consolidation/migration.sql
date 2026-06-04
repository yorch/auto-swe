-- Add soft-delete column to agent_lessons for consolidation support.
-- Rows with a non-null consolidated_at were merged into a newer consolidated
-- lesson and should be excluded from retrieval. They are kept for audit.
ALTER TABLE agent_lessons ADD COLUMN consolidated_at TIMESTAMPTZ;
