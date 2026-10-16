-- AlterTable
ALTER TABLE "agent_traces" ADD COLUMN     "assistant_message_id" UUID;

-- CreateIndex
CREATE INDEX "agent_traces_assistant_message_id_idx" ON "agent_traces"("assistant_message_id");

-- AddForeignKey
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_assistant_message_id_fkey" FOREIGN KEY ("assistant_message_id") REFERENCES "assistant_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
