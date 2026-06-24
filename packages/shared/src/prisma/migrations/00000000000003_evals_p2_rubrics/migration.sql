-- Migration: evals_p2_rubrics
-- P2 (docs/evals-p2.md): admin-extensible judge rubric table.

-- CreateTable
CREATE TABLE "eval_rubrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL DEFAULT 'GLOBAL',
    "team_id" UUID,
    "org_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "prompt_text" TEXT NOT NULL,
    "scale" TEXT NOT NULL DEFAULT '0..1',
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_rubrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eval_rubrics_scope_slug_idx" ON "eval_rubrics"("scope", "slug");

