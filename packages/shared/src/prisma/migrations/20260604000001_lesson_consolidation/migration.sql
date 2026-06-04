-- Lesson consolidation feature (PR #53).
--
-- 1. agent_lessons: soft-delete column — rows with a non-null consolidated_at
--    were merged into a consolidated lesson and are excluded from retrieval.
--    Kept for audit; metadata.consolidatedFrom records source row IDs.
ALTER TABLE agent_lessons ADD COLUMN consolidated_at TIMESTAMPTZ;

-- 2. repositories: per-repo opt-in flag. Defaults to true so all active repos
--    participate in scheduled consolidation without manual opt-in.
ALTER TABLE repositories
  ADD COLUMN consolidation_enabled BOOLEAN NOT NULL DEFAULT true;

-- 3. workflow_defaults: consolidation schedule config read by the gateway on
--    startup and on every admin save to sync the Temporal Schedule.
ALTER TABLE workflow_defaults
  ADD COLUMN consolidation_enabled           BOOLEAN          NOT NULL DEFAULT true,
  ADD COLUMN consolidation_cron              TEXT             NOT NULL DEFAULT '0 3 * * 0',
  ADD COLUMN consolidation_min_cluster_size  INTEGER          NOT NULL DEFAULT 3,
  ADD COLUMN consolidation_similarity_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.85;
