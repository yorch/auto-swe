ALTER TABLE "workflow_templates" ADD COLUMN "kind" TEXT;
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_kind_check"
    CHECK ("kind" IS NULL OR "kind" = 'review');

ALTER TABLE "workflow_runs" ADD COLUMN "review_of_run_id" UUID,
    ADD COLUMN "review_preset_id" UUID;

CREATE TABLE "review_presets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "template_id" UUID NOT NULL,
    "system_prompt" TEXT,
    "on_blocking" TEXT NOT NULL DEFAULT 'report',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_presets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_presets_on_blocking_check" CHECK ("on_blocking" IN ('report', 'fix'))
);

CREATE TABLE "review_preset_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "preset_id" UUID NOT NULL,
    "template_id" UUID,
    "connection_id" UUID,
    "created_by_id" UUID,
    CONSTRAINT "review_preset_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_preset_attachments_target_check"
        CHECK (("template_id" IS NOT NULL) <> ("connection_id" IS NOT NULL))
);

CREATE TABLE "review_launch_intents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_run_id" UUID NOT NULL,
    "preset_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "review_run_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_launch_intents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_launch_intents_status_check"
        CHECK ("status" IN ('pending', 'started', 'skipped', 'failed')),
    CONSTRAINT "review_launch_intents_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "review_presets_name_key" ON "review_presets"("name");
CREATE INDEX "review_presets_template_id_idx" ON "review_presets"("template_id");
CREATE INDEX "review_presets_created_by_id_idx" ON "review_presets"("created_by_id");
CREATE INDEX "review_preset_attachments_template_id_idx" ON "review_preset_attachments"("template_id");
CREATE INDEX "review_preset_attachments_connection_id_idx" ON "review_preset_attachments"("connection_id");
CREATE INDEX "review_preset_attachments_created_by_id_idx" ON "review_preset_attachments"("created_by_id");
CREATE UNIQUE INDEX "review_preset_attachments_preset_id_template_id_key" ON "review_preset_attachments"("preset_id", "template_id");
CREATE UNIQUE INDEX "review_preset_attachments_preset_id_connection_id_key" ON "review_preset_attachments"("preset_id", "connection_id");
CREATE INDEX "review_launch_intents_preset_id_idx" ON "review_launch_intents"("preset_id");
CREATE INDEX "review_launch_intents_review_run_id_idx" ON "review_launch_intents"("review_run_id");
CREATE INDEX "review_launch_intents_status_updated_at_idx" ON "review_launch_intents"("status", "updated_at");
CREATE UNIQUE INDEX "review_launch_intents_source_run_id_preset_id_key" ON "review_launch_intents"("source_run_id", "preset_id");
CREATE INDEX "workflow_runs_review_of_run_id_idx" ON "workflow_runs"("review_of_run_id");
CREATE INDEX "workflow_runs_review_preset_id_idx" ON "workflow_runs"("review_preset_id");

ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_review_of_run_id_fkey" FOREIGN KEY ("review_of_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_review_preset_id_fkey" FOREIGN KEY ("review_preset_id") REFERENCES "review_presets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "review_presets" ADD CONSTRAINT "review_presets_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_presets" ADD CONSTRAINT "review_presets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "review_preset_attachments" ADD CONSTRAINT "review_preset_attachments_preset_id_fkey" FOREIGN KEY ("preset_id") REFERENCES "review_presets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_preset_attachments" ADD CONSTRAINT "review_preset_attachments_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_preset_attachments" ADD CONSTRAINT "review_preset_attachments_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_preset_attachments" ADD CONSTRAINT "review_preset_attachments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "review_launch_intents" ADD CONSTRAINT "review_launch_intents_source_run_id_fkey" FOREIGN KEY ("source_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_launch_intents" ADD CONSTRAINT "review_launch_intents_preset_id_fkey" FOREIGN KEY ("preset_id") REFERENCES "review_presets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_launch_intents" ADD CONSTRAINT "review_launch_intents_review_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A CHECK cannot read another table. Lock the template against a concurrent kind change.
CREATE FUNCTION "check_review_preset_template_kind"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE template_kind TEXT;
BEGIN
    SELECT "kind" INTO template_kind FROM "workflow_templates"
        WHERE "id" = NEW."template_id" FOR SHARE;
    IF template_kind IS DISTINCT FROM 'review' THEN
        RAISE EXCEPTION 'Review presets require a review-kind template'
            USING ERRCODE = '23514', CONSTRAINT = 'review_presets_template_kind_check';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "review_presets_template_kind_check"
    BEFORE INSERT OR UPDATE OF "template_id" ON "review_presets"
    FOR EACH ROW EXECUTE FUNCTION "check_review_preset_template_kind"();

CREATE FUNCTION "protect_review_template_kind"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."kind" IS DISTINCT FROM 'review' AND EXISTS (
        SELECT 1 FROM "review_presets" WHERE "template_id" = OLD."id"
    ) THEN
        RAISE EXCEPTION 'A template used by a review preset must remain review-kind'
            USING ERRCODE = '23514', CONSTRAINT = 'review_presets_template_kind_check';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "workflow_templates_review_preset_kind_check"
    BEFORE UPDATE OF "kind" ON "workflow_templates"
    FOR EACH ROW EXECUTE FUNCTION "protect_review_template_kind"();
