-- AlterTable: Add language and description columns to repositories
ALTER TABLE "repositories" ADD COLUMN "language" TEXT;
ALTER TABLE "repositories" ADD COLUMN "description" TEXT;

-- AlterTable: Make team_id NOT NULL (all existing rows already have team_id set)
ALTER TABLE "repositories" ALTER COLUMN "team_id" SET NOT NULL;

-- DropForeignKey: Remove old nullable FK with ON DELETE SET NULL
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_team_id_fkey";

-- AddForeignKey: Re-add FK as non-nullable with ON DELETE RESTRICT
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
