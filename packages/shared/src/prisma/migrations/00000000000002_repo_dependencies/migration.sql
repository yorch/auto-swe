-- Repo dependency graph — see docs/history/repo-dependency-graph-rfc.md.
--
-- Hand-written migration. It adds the `package_names` column on `connections`,
-- the `repo_dependencies` edge table, and the CHECK constraints / partial unique
-- indexes Prisma's DSL cannot express. Per the prisma-pgvector-hnsw skill,
-- non-expressible DDL lives in its own new migration and is never folded into an
-- already-applied one (00000000000001), which every environment has run.

-- Declared package name(s) each git_repo publishes — the resolution key manifest
-- detection matches a dependency string against (P1).
ALTER TABLE "connections"
    ADD COLUMN "package_names" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "repo_dependencies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "from_repo_id" UUID NOT NULL,
    "to_repo_id" UUID,
    "to_ref" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'code',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "detail" JSONB,
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by_id" UUID,
    "confirmed_at" TIMESTAMPTZ,
    "dismissed_by_id" UUID,
    "dismissed_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repo_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repo_dependencies_from_repo_id_idx" ON "repo_dependencies"("from_repo_id");
CREATE INDEX "repo_dependencies_to_repo_id_idx" ON "repo_dependencies"("to_repo_id");

-- AddForeignKey
ALTER TABLE "repo_dependencies"
    ADD CONSTRAINT "repo_dependencies_from_repo_id_fkey"
    FOREIGN KEY ("from_repo_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repo_dependencies"
    ADD CONSTRAINT "repo_dependencies_to_repo_id_fkey"
    FOREIGN KEY ("to_repo_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Non-expressible DDL (Prisma's DSL can't state these) ────────────────────

-- Resolved edges: one per (from, to, kind, source). Suggestions carry a null
-- to_repo_id and Postgres treats NULLs as distinct, so a plain unique would let
-- duplicate suggestions through — scope real-edge uniqueness with a partial index.
CREATE UNIQUE INDEX "repo_dependencies_resolved_uidx"
    ON "repo_dependencies"("from_repo_id", "to_repo_id", "kind", "source")
    WHERE "to_repo_id" IS NOT NULL;

-- Unresolved suggestions: one per (from, to_ref, kind, source).
CREATE UNIQUE INDEX "repo_dependencies_suggestion_uidx"
    ON "repo_dependencies"("from_repo_id", "to_ref", "kind", "source")
    WHERE "to_repo_id" IS NULL;

-- A row points at a repo or names an unresolved ref, never neither.
ALTER TABLE "repo_dependencies"
    ADD CONSTRAINT "repo_dependencies_target_shape_check"
    CHECK ("to_repo_id" IS NOT NULL OR "to_ref" IS NOT NULL);

-- No self-edges (holds trivially when to_repo_id is null).
ALTER TABLE "repo_dependencies"
    ADD CONSTRAINT "repo_dependencies_no_self_edge_check"
    CHECK ("to_repo_id" IS NULL OR "from_repo_id" <> "to_repo_id");

-- Status / source enums kept as TEXT with a CHECK, per the enum→string house style.
ALTER TABLE "repo_dependencies"
    ADD CONSTRAINT "repo_dependencies_status_check"
    CHECK ("status" IN ('active', 'proposed', 'dismissed', 'unresolved'));
ALTER TABLE "repo_dependencies"
    ADD CONSTRAINT "repo_dependencies_source_check"
    CHECK ("source" IN ('manual', 'manifest', 'git_signal', 'inferred'));
