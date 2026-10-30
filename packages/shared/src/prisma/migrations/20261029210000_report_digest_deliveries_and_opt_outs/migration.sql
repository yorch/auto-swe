UPDATE "report_digest_subscriptions"
SET "last_period_start" = NULL;

ALTER TABLE "report_digest_subscriptions"
  ADD COLUMN "opted_out_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "report_digest_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscription_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'failed',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_digest_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_digest_deliveries_subscription_id_period_start_targe_key"
  ON "report_digest_deliveries"("subscription_id", "period_start", "target");
CREATE INDEX "report_digest_deliveries_subscription_id_period_start_statu_idx"
  ON "report_digest_deliveries"("subscription_id", "period_start", "status");

ALTER TABLE "report_digest_deliveries"
  ADD CONSTRAINT "report_digest_deliveries_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "report_digest_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
