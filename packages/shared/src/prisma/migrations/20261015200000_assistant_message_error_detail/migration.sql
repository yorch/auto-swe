-- AlterTable
ALTER TABLE "assistant_messages" ADD COLUMN     "error_detail" TEXT;

-- CreateIndex
CREATE INDEX "assistant_messages_status_created_at_idx" ON "assistant_messages"("status", "created_at");
