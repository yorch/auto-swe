-- AlterTable
ALTER TABLE "users" ADD COLUMN     "approved_at" TIMESTAMPTZ,
ADD COLUMN     "approval_source" TEXT;
