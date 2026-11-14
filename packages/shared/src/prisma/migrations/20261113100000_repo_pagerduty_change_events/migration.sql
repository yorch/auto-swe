-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "pagerduty_events_connection_id" UUID;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_pagerduty_events_connection_id_fkey" FOREIGN KEY ("pagerduty_events_connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
