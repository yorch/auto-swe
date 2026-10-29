CREATE TYPE "ReportDigestScope" AS ENUM ('ORGANIZATION', 'TEAM');

CREATE TABLE "report_digest_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" "ReportDigestScope" NOT NULL,
    "org_id" UUID,
    "team_id" UUID,
    "slack_channel_id" UUID,
    "email_recipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "last_sent_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_digest_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_digest_subscriptions_scope_check"
      CHECK (("org_id" IS NOT NULL AND "team_id" IS NULL) OR ("org_id" IS NULL AND "team_id" IS NOT NULL))
);

CREATE INDEX "report_digest_subscriptions_enabled_idx" ON "report_digest_subscriptions"("enabled");

ALTER TABLE "report_digest_subscriptions"
  ADD CONSTRAINT "report_digest_subscriptions_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "report_digest_subscriptions"
  ADD CONSTRAINT "report_digest_subscriptions_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "report_digest_subscriptions"
  ADD CONSTRAINT "report_digest_subscriptions_slack_channel_id_fkey"
  FOREIGN KEY ("slack_channel_id") REFERENCES "slack_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
