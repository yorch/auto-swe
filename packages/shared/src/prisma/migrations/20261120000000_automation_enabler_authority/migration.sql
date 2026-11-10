-- AlterTable
ALTER TABLE "automations" ADD COLUMN     "last_enabled_by_id" UUID,
ADD COLUMN     "auto_disabled_reason" TEXT,
ADD COLUMN     "auto_disabled_at" TIMESTAMPTZ;

-- Backfill: until now the person an automation answers to was its creator. A row whose creator is
-- gone (created_by_id is NULL) keeps no one, which the engine's check at fire time refuses.
UPDATE "automations" SET "last_enabled_by_id" = "created_by_id";

-- CreateIndex
CREATE INDEX "automations_last_enabled_by_id_idx" ON "automations"("last_enabled_by_id");

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_last_enabled_by_id_fkey" FOREIGN KEY ("last_enabled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
