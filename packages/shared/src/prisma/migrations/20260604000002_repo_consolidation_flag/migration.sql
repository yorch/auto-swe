-- Per-repo opt-in flag for scheduled lesson consolidation. Defaults to true
-- so existing repos are included automatically without manual opt-in.
ALTER TABLE repositories ADD COLUMN consolidation_enabled BOOLEAN NOT NULL DEFAULT true;
