-- AlterTable
ALTER TABLE "run_steering_messages" ADD COLUMN     "author_service_id" UUID;

-- CreateIndex
CREATE INDEX "run_steering_messages_author_service_id_idx" ON "run_steering_messages"("author_service_id");

-- AddForeignKey
ALTER TABLE "run_steering_messages" ADD CONSTRAINT "run_steering_messages_author_service_id_fkey" FOREIGN KEY ("author_service_id") REFERENCES "service_principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

