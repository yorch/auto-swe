ALTER TABLE "workflow_templates"
    DROP CONSTRAINT "workflow_templates_kind_check",
    ADD CONSTRAINT "workflow_templates_kind_check"
        CHECK ("kind" IS NULL OR "kind" IN ('review', 'automation'));
