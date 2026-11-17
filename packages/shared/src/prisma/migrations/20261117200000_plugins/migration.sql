-- CreateEnum
CREATE TYPE "HarnessProfileTrackStatus" AS ENUM ('OK', 'UPDATE_AVAILABLE', 'ERROR');

-- CreateEnum
CREATE TYPE "MarketplaceSourceStatus" AS ENUM ('OK', 'UPDATE_AVAILABLE', 'ERROR', 'DISABLED');

-- AlterTable
ALTER TABLE "skills" ADD COLUMN     "plugin_profile_id" UUID,
ADD COLUMN     "plugin_version" INTEGER;

-- AlterTable
ALTER TABLE "harness_profiles" ADD COLUMN     "hooks_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "last_checked_at" TIMESTAMPTZ,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "latest_sha" TEXT,
ADD COLUMN     "marketplace_entry" TEXT,
ADD COLUMN     "marketplace_source_id" UUID,
ADD COLUMN     "track_status" "HarnessProfileTrackStatus" NOT NULL DEFAULT 'OK';

-- AlterTable
-- harness_profile (text) becomes harness_profiles (text[]) in place: a bound name carries over
-- as a one-element list, no binding becomes the empty list. NOT NULL is hand-written because
-- Prisma emits array columns without it (see 20260618000001_custom_constraints_and_indexes).
ALTER TABLE "agents" ADD COLUMN "harness_profiles" TEXT[] DEFAULT ARRAY[]::TEXT[];

UPDATE "agents"
SET "harness_profiles" = CASE
  WHEN "harness_profile" IS NULL THEN ARRAY[]::TEXT[]
  ELSE ARRAY["harness_profile"]
END;

ALTER TABLE "agents" ALTER COLUMN "harness_profiles" SET NOT NULL;
ALTER TABLE "agents" DROP COLUMN "harness_profile";

-- CreateTable
CREATE TABLE "marketplace_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "host" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '',
    "ref" TEXT NOT NULL,
    "pinned_sha" TEXT NOT NULL,
    "latest_sha" TEXT,
    "last_checked_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "status" "MarketplaceSourceStatus" NOT NULL DEFAULT 'OK',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_enablements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "enabled_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_enablements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketplace_sources_created_by_id_idx" ON "marketplace_sources"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_sources_host_owner_repo_path_key" ON "marketplace_sources"("host", "owner", "repo", "path");

-- CreateIndex
CREATE INDEX "plugin_enablements_team_id_idx" ON "plugin_enablements"("team_id");

-- CreateIndex
CREATE INDEX "plugin_enablements_enabled_by_id_idx" ON "plugin_enablements"("enabled_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_enablements_profile_id_team_id_key" ON "plugin_enablements"("profile_id", "team_id");

-- CreateIndex
CREATE INDEX "skills_plugin_profile_id_idx" ON "skills"("plugin_profile_id");

-- CreateIndex
CREATE INDEX "harness_profiles_marketplace_source_id_idx" ON "harness_profiles"("marketplace_source_id");

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_plugin_profile_id_fkey" FOREIGN KEY ("plugin_profile_id") REFERENCES "harness_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_sources" ADD CONSTRAINT "marketplace_sources_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_enablements" ADD CONSTRAINT "plugin_enablements_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "harness_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_enablements" ADD CONSTRAINT "plugin_enablements_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_enablements" ADD CONSTRAINT "plugin_enablements_enabled_by_id_fkey" FOREIGN KEY ("enabled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harness_profiles" ADD CONSTRAINT "harness_profiles_marketplace_source_id_fkey" FOREIGN KEY ("marketplace_source_id") REFERENCES "marketplace_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

