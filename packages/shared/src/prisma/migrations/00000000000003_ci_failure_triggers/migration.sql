-- CreateTable
CREATE TABLE "ci_failure_triggers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events" TEXT[],
    "branch_patterns" TEXT[],
    "workflow_patterns" TEXT[],
    "inputs" JSONB NOT NULL DEFAULT '{}',
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 30,
    "max_runs_per_day" INTEGER NOT NULL DEFAULT 10,
    "template_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ci_failure_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ci_failure_trigger_fires" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "github_run_id" TEXT NOT NULL,
    "run_attempt" INTEGER NOT NULL,
    "workflow_path" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "head_branch" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "pull_request_number" INTEGER,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "temporal_workflow_id" TEXT,
    "work_request_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ci_failure_trigger_fires_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ci_failure_triggers_connection_id_idx" ON "ci_failure_triggers"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "ci_failure_trigger_fires_dedupe_key_key" ON "ci_failure_trigger_fires"("dedupe_key");

-- CreateIndex
CREATE INDEX "ci_failure_trigger_fires_trigger_id_created_at_idx" ON "ci_failure_trigger_fires"("trigger_id", "created_at");

-- CreateIndex
CREATE INDEX "ci_failure_trigger_fires_trigger_id_head_branch_created_at_idx" ON "ci_failure_trigger_fires"("trigger_id", "head_branch", "created_at");

-- CreateIndex
CREATE INDEX "ci_failure_trigger_fires_trigger_id_head_sha_idx" ON "ci_failure_trigger_fires"("trigger_id", "head_sha");

-- AddForeignKey
ALTER TABLE "ci_failure_triggers" ADD CONSTRAINT "ci_failure_triggers_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_failure_triggers" ADD CONSTRAINT "ci_failure_triggers_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_failure_triggers" ADD CONSTRAINT "ci_failure_triggers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_failure_trigger_fires" ADD CONSTRAINT "ci_failure_trigger_fires_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "ci_failure_triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: DDL the Prisma schema cannot express (see the prisma-pgvector-hnsw skill).
-- A trigger's lists are never null and never empty: an empty list would read as "match
-- nothing" in code but "match everything" to a person reading the row.
ALTER TABLE "ci_failure_triggers" ALTER COLUMN "events" SET NOT NULL;
ALTER TABLE "ci_failure_triggers" ALTER COLUMN "branch_patterns" SET NOT NULL;
ALTER TABLE "ci_failure_triggers" ALTER COLUMN "workflow_patterns" SET NOT NULL;
ALTER TABLE "ci_failure_triggers" ADD CONSTRAINT "ci_failure_triggers_lists_nonempty"
  CHECK (cardinality("events") > 0 AND cardinality("branch_patterns") > 0 AND cardinality("workflow_patterns") > 0);
ALTER TABLE "ci_failure_triggers" ADD CONSTRAINT "ci_failure_triggers_events_known"
  CHECK ("events" <@ ARRAY['push', 'pull_request']::TEXT[]);
ALTER TABLE "ci_failure_triggers" ADD CONSTRAINT "ci_failure_triggers_bounds"
  CHECK ("cooldown_minutes" BETWEEN 0 AND 10080 AND "max_runs_per_day" BETWEEN 1 AND 500);
-- A trigger's options are a flat object of template inputs, never another JSON shape.
ALTER TABLE "ci_failure_triggers" ADD CONSTRAINT "ci_failure_triggers_inputs_object"
  CHECK (jsonb_typeof("inputs") = 'object');
