-- The model catalog: one row per `<provider>/<model-id>` spec with the per-MTok
-- USD prices LLM calls are costed at, editable by an admin instead of fixed in
-- code. Global, so the uniqueness rule is an ordinary index — no partial index
-- or other DDL outside what the schema expresses.
--
-- The table starts empty. `syncModelCatalog` fills it from `BUILTIN_MODELS` at
-- gateway startup, so the seed lives in one place rather than also in SQL.

-- CreateEnum
CREATE TYPE "ModelKind" AS ENUM ('CHAT', 'EMBEDDING');

-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('ACTIVE', 'DEPRECATED', 'RETIRED');

-- CreateTable
CREATE TABLE "model_catalog_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "kind" "ModelKind" NOT NULL DEFAULT 'CHAT',
    "display_name" TEXT,
    "input_usd_per_mtok" DOUBLE PRECISION NOT NULL,
    "output_usd_per_mtok" DOUBLE PRECISION NOT NULL,
    "status" "ModelStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "is_customized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_catalog_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_catalog_entries_provider_model_id_key" ON "model_catalog_entries"("provider", "model_id");
