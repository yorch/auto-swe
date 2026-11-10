-- CreateEnum
CREATE TYPE "HarnessProfileStatus" AS ENUM ('OK', 'DISABLED');

-- CreateTable
CREATE TABLE "harness_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '',
    "ref" TEXT NOT NULL,
    "status" "HarnessProfileStatus" NOT NULL DEFAULT 'OK',
    "latest_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "harness_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "harness_profile_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "file_index" JSONB NOT NULL,
    "file_count" INTEGER NOT NULL,
    "total_bytes" INTEGER NOT NULL,
    "files" BYTEA NOT NULL,
    "scan_warnings" JSONB NOT NULL DEFAULT '[]',
    "approved_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "harness_profile_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "harness_profiles_name_key" ON "harness_profiles"("name");

-- CreateIndex
CREATE INDEX "harness_profile_versions_approved_by_id_idx" ON "harness_profile_versions"("approved_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "harness_profile_versions_profile_id_version_key" ON "harness_profile_versions"("profile_id", "version");

-- AddForeignKey
ALTER TABLE "harness_profile_versions" ADD CONSTRAINT "harness_profile_versions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "harness_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harness_profile_versions" ADD CONSTRAINT "harness_profile_versions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written (Prisma cannot express an expression index; the schema diff ignores it, like
-- connections' lower() index): a profile name is unique ignoring case, so two concurrent creates of
-- "Demo" and "demo" cannot both pass the application-level check.
CREATE UNIQUE INDEX "harness_profiles_name_lower_key" ON "harness_profiles" (lower("name"));
