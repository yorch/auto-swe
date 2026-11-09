-- On-demand workspace tools: an admin-managed catalog of pinned downloads, and the per-repository
-- switches that decide whether `.auto-swe/tools.yml` is honoured.
CREATE TYPE "ToolStatus" AS ENUM ('ACTIVE', 'DEPRECATED', 'REVOKED');

CREATE TABLE "tool_catalog_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "archs" JSONB NOT NULL,
    "member" TEXT NOT NULL,
    "libc" TEXT NOT NULL DEFAULT 'any',
    "description" TEXT,
    "status" "ToolStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "is_customized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_catalog_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tool_catalog_entries_key_version_key" ON "tool_catalog_entries"("key", "version");

-- Hand-written: Prisma cannot express a CHECK.
ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_libc_check"
    CHECK ("libc" IN ('musl', 'glibc', 'any'));

ALTER TABLE "connections" ADD COLUMN     "tools_file_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tools" JSONB,
ADD COLUMN     "tools_deny" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Hand-written: Prisma emits array columns nullable, but the model declares this one required.
ALTER TABLE "connections" ALTER COLUMN "tools_deny" SET NOT NULL;
