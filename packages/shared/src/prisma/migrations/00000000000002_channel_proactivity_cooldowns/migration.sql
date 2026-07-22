-- ----------------------------------------------------------------------------
-- Per-entity proactivity cooldown knobs on slack_channels. All nullable
-- (NULL = use the worker's built-in default), matching the existing
-- consolidation_min_cluster_size / _similarity_threshold override pattern.
-- Plain additive columns (Prisma-expressible), so this is an ordinary
-- incremental migration.
-- ----------------------------------------------------------------------------
ALTER TABLE "slack_channels"
  ADD COLUMN "reactive_cooldown_minutes"     INTEGER,
  ADD COLUMN "reactive_lookback_minutes"     INTEGER,
  ADD COLUMN "org_flag_cooldown_hours"       INTEGER,
  ADD COLUMN "open_item_nudge_after_hours"   INTEGER,
  ADD COLUMN "open_item_nudge_cooldown_hours" INTEGER;
