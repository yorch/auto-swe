-- ----------------------------------------------------------------------------
-- Reactive interjection (Gap A): per-channel opt-in proactive responding.
-- Adds the reactive-mode config + cursor/cooldown columns to slack_channels.
-- ----------------------------------------------------------------------------

ALTER TABLE "slack_channels"
    ADD COLUMN "reactive_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "reactive_cron" TEXT,
    ADD COLUMN "last_reactive_check_at" TIMESTAMPTZ,
    ADD COLUMN "last_reactive_at" TIMESTAMPTZ;
