-- Passive memory ingestion (Gap G): two new columns on slack_channels.
-- passiveIngestEnabled: opt-in flag (default false) so channels are passive-ingest-aware only when enabled.
-- passiveIngestCursor: stores the Slack ts string of the newest message already processed.

ALTER TABLE slack_channels
  ADD COLUMN IF NOT EXISTS passive_ingest_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS passive_ingest_cursor  TEXT;
