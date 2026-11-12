-- AlterTable
ALTER TABLE "event_endpoints" ADD COLUMN     "cancel_on_types" TEXT[] DEFAULT ARRAY[]::TEXT[];
