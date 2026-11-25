-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "plan_failed_at" TIMESTAMPTZ,
ADD COLUMN     "plan_failure_reason" TEXT;

-- CreateTable
CREATE TABLE "campaign_discovery_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "base_sha" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_discovery_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_discovery_checks_connection_id_idx" ON "campaign_discovery_checks"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_discovery_checks_campaign_id_connection_id_key" ON "campaign_discovery_checks"("campaign_id", "connection_id");

-- AddForeignKey
ALTER TABLE "campaign_discovery_checks" ADD CONSTRAINT "campaign_discovery_checks_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_discovery_checks" ADD CONSTRAINT "campaign_discovery_checks_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
