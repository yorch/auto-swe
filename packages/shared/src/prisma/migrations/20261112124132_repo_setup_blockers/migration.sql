CREATE TABLE "repo_setup_blockers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "step" TEXT,
    "detail" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_workflow_id" TEXT,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "repo_setup_blockers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "repo_setup_blockers_connection_id_kind_subject_key" ON "repo_setup_blockers"("connection_id", "kind", "subject");

ALTER TABLE "repo_setup_blockers" ADD CONSTRAINT "repo_setup_blockers_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
