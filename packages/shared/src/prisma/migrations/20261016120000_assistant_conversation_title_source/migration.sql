-- CreateEnum
CREATE TYPE "AssistantTitleSource" AS ENUM ('FIRST_MESSAGE', 'MODEL', 'USER');

-- AlterTable
ALTER TABLE "assistant_conversations" ADD COLUMN     "title_source" "AssistantTitleSource" NOT NULL DEFAULT 'FIRST_MESSAGE';
