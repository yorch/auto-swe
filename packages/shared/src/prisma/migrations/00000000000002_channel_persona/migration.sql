-- Add persona prompt fields (channel-persona feature).
-- Both columns are nullable TEXT — no backfill required.
ALTER TABLE "organizations" ADD COLUMN "default_persona_prompt" TEXT;
ALTER TABLE "slack_channels" ADD COLUMN "persona_prompt" TEXT;
