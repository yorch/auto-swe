-- Lesson consolidation schedule config stored alongside other workflow defaults.
-- The gateway reads these on startup and when the admin saves changes, then
-- syncs the Temporal Schedule accordingly.
ALTER TABLE workflow_defaults
  ADD COLUMN consolidation_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN consolidation_cron TEXT NOT NULL DEFAULT '0 3 * * 0',
  ADD COLUMN consolidation_min_cluster_size INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN consolidation_similarity_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.85;
