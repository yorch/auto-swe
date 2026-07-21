-- ----------------------------------------------------------------------------
-- Per-connector "allow private network" opt-in. An admin who configures a
-- self-hosted issue-tracker / knowledge-base instance on an internal address
-- must explicitly set this so the SSRF guard (lib/integrations/registry.ts)
-- permits that base URL. Default false = internal base URLs are rejected.
-- Plain additive boolean columns (Prisma-expressible), so this is an ordinary
-- incremental migration rather than part of the custom-constraints file.
-- ----------------------------------------------------------------------------
ALTER TABLE "issue_tracker_config"
  ADD COLUMN "allow_private_network" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "knowledge_base_config"
  ADD COLUMN "allow_private_network" BOOLEAN NOT NULL DEFAULT false;
