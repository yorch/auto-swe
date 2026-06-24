-- ----------------------------------------------------------------------------
-- Claude Tag foundation: Slack workspace + channel identity, per-channel
-- billing, and channel/team/org scoping columns on memory_items + agents.
--
-- Additive only. Existing SWE-repo behavior is untouched: the new columns are
-- nullable, the new tables stand alone, and the CHANNEL config tier only fires
-- when a SlackChannel exists.
-- ----------------------------------------------------------------------------

-- ── Slack workspaces ────────────────────────────────────────────────────────
CREATE TABLE "slack_workspaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slack_team_id" TEXT NOT NULL,
    "name" TEXT,
    "org_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_workspaces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_workspaces_slack_team_id_key" ON "slack_workspaces" ("slack_team_id");
CREATE INDEX "slack_workspaces_org_id_idx" ON "slack_workspaces" ("org_id");

ALTER TABLE "slack_workspaces"
    ADD CONSTRAINT "slack_workspaces_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Slack channels ──────────────────────────────────────────────────────────
CREATE TABLE "slack_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slack_channel_id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT,
    "team_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "agent_key" TEXT NOT NULL DEFAULT 'channelAssistant',
    "ambient_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ambient_cron" TEXT,
    "monthly_budget_usd_cents" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_channels_workspace_id_slack_channel_id_key"
    ON "slack_channels" ("workspace_id", "slack_channel_id");
CREATE INDEX "slack_channels_team_id_idx" ON "slack_channels" ("team_id");
CREATE INDEX "slack_channels_org_id_idx" ON "slack_channels" ("org_id");

ALTER TABLE "slack_channels"
    ADD CONSTRAINT "slack_channels_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "slack_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_channels"
    ADD CONSTRAINT "slack_channels_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "slack_channels"
    ADD CONSTRAINT "slack_channels_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Per-channel monthly usage (budget) ──────────────────────────────────────
CREATE TABLE "channel_monthly_usage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel_id" UUID NOT NULL,
    "year_month" TEXT NOT NULL,
    "cost_usd_accrued" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "runs_completed" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_monthly_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_monthly_usage_channel_id_year_month_key"
    ON "channel_monthly_usage" ("channel_id", "year_month");
CREATE INDEX "channel_monthly_usage_channel_id_idx" ON "channel_monthly_usage" ("channel_id");

ALTER TABLE "channel_monthly_usage"
    ADD CONSTRAINT "channel_monthly_usage_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "slack_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── memory_items: channel/team/org scoping ──────────────────────────────────
ALTER TABLE "memory_items" ADD COLUMN "channel_id" UUID;
ALTER TABLE "memory_items" ADD COLUMN "team_id" UUID;
ALTER TABLE "memory_items" ADD COLUMN "org_id" UUID;

CREATE INDEX "memory_items_channel_id_consolidated_at_idx"
    ON "memory_items" ("channel_id", "consolidated_at");
CREATE INDEX "memory_items_team_id_consolidated_at_idx"
    ON "memory_items" ("team_id", "consolidated_at");
CREATE INDEX "memory_items_org_id_consolidated_at_idx"
    ON "memory_items" ("org_id", "consolidated_at");

ALTER TABLE "memory_items"
    ADD CONSTRAINT "memory_items_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "slack_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── agents: CHANNEL-scoped rows ─────────────────────────────────────────────
ALTER TABLE "agents" ADD COLUMN "channel_id" UUID;

CREATE INDEX "agents_scope_channel_id_idx" ON "agents" ("scope", "channel_id");

ALTER TABLE "agents"
    ADD CONSTRAINT "agents_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "slack_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One active row per (key, version) at CHANNEL scope, like the other scopes.
CREATE UNIQUE INDEX "agents_key_version_channel_uidx"
    ON "agents" ("key", "version", "channel_id")
    WHERE "scope" = 'CHANNEL';
