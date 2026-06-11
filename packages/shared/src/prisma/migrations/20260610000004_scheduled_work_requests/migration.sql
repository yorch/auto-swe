-- EVOL: scheduled / recurring work requests. One row = one Temporal Schedule
-- that fires RunnableWorkflow on a cron cadence against a repo. The standing
-- WorkRequest (work_request_id) anchors every fire's WorkflowRun rows.
CREATE TABLE "scheduled_work_requests" (
  "id"                     UUID         NOT NULL DEFAULT gen_random_uuid(),
  "name"                   TEXT         NOT NULL,
  "cron_expression"        TEXT         NOT NULL,
  "repo_id"                UUID         NOT NULL,
  "template_id"            UUID,
  "template_version"       INTEGER,
  "description"            TEXT         NOT NULL,
  "external_ticket_prefix" TEXT         NOT NULL,
  "budget_tier"            TEXT         NOT NULL DEFAULT 'STANDARD',
  "is_active"              BOOLEAN      NOT NULL DEFAULT true,
  "created_by_id"          UUID,
  "work_request_id"        UUID,
  "last_fired_at"          TIMESTAMPTZ,
  "next_fire_at"           TIMESTAMPTZ,
  "created_at"             TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "scheduled_work_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scheduled_work_requests_repo_id_idx"
  ON "scheduled_work_requests" ("repo_id");

ALTER TABLE "scheduled_work_requests"
  ADD CONSTRAINT "scheduled_work_requests_repo_id_fkey"
    FOREIGN KEY ("repo_id") REFERENCES "repositories"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scheduled_work_requests"
  ADD CONSTRAINT "scheduled_work_requests_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "scheduled_work_requests"
  ADD CONSTRAINT "scheduled_work_requests_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "scheduled_work_requests"
  ADD CONSTRAINT "scheduled_work_requests_work_request_id_fkey"
    FOREIGN KEY ("work_request_id") REFERENCES "work_requests"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
