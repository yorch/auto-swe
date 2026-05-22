-- CreateTable
CREATE TABLE "embedding_configs" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "model_spec" TEXT NOT NULL,
    "credential_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_configs_pkey" PRIMARY KEY ("id")
);

-- Singleton enforcement: the `id` column must always be the literal 'default'.
-- The Prisma model uses `@default("default")` so writes through the client
-- always produce the right value; this check is belt-and-suspenders against
-- raw SQL inserts.
ALTER TABLE "embedding_configs"
    ADD CONSTRAINT "embedding_configs_singleton_check"
    CHECK ("id" = 'default');

-- AddForeignKey
ALTER TABLE "embedding_configs" ADD CONSTRAINT "embedding_configs_credential_id_fkey"
    FOREIGN KEY ("credential_id") REFERENCES "provider_credentials"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the default row for existing deployments so they keep working
-- immediately after the Phase-6 cutover (worker now reads this row instead
-- of the EMBEDDING_MODEL env var). New deployments will override via the
-- dashboard before bringing up the worker.
INSERT INTO "embedding_configs" ("id", "model_spec")
VALUES ('default', 'openai/text-embedding-3-large')
ON CONFLICT ("id") DO NOTHING;
