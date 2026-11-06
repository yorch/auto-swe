-- A repository's workspace setup definition. NULL reads `.auto-swe/setup.yml` instead.
ALTER TABLE "connections" ADD COLUMN     "setup_config" JSONB;

-- CreateTable
CREATE TABLE "workspace_setup_caches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cache_key" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "artifact_id" UUID NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_setup_caches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_setup_caches_cache_key_key" ON "workspace_setup_caches"("cache_key");

-- CreateIndex
CREATE INDEX "workspace_setup_caches_last_used_at_idx" ON "workspace_setup_caches"("last_used_at");
