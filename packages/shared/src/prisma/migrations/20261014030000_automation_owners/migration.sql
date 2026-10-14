-- The decision ledger belongs to an OWNER, not only to a repository (docs/automations.md §2),
-- and an event automation may belong to a team instead of a repository.

-- ── automation_fires: the owner key ────────────────────────────────────────
-- The column keeps its name (`repo_key`; Prisma calls it `ownerKey`): renaming it would break
-- every older gateway and worker still running during a rolling deploy. A repository's key keeps
-- its exact spelling (`<host>/<owner>/<repo>`, lowercased, no prefix): every event source's
-- dedupe key embeds it, and a redelivered webhook must still find the decision recorded for it.

-- Schedules and template webhooks wrote an empty key: their rows are read by the schedule's or
-- template's id (`subject_key`), never by repository. They take the sigil form every owner that
-- is not a repository has, `@owner/<that id>`; a host never contains `@`.
UPDATE "automation_fires" SET "repo_key" = '@owner/' || "subject_key" WHERE "repo_key" = '';

-- ── automations: a repository or a team ─────────────────────────────────────
ALTER TABLE "automations" ALTER COLUMN "connection_id" DROP NOT NULL;
ALTER TABLE "automations" ADD COLUMN "team_id" UUID;
ALTER TABLE "automations" ADD CONSTRAINT "automations_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "automations_team_id_source_idx" ON "automations"("team_id", "source");

-- Hand-written: DDL the Prisma schema cannot express (see the prisma-pgvector-hnsw skill).
-- Every automation belongs to something that manages it.
ALTER TABLE "automations" ADD CONSTRAINT "automations_owner_present"
  CHECK ("connection_id" IS NOT NULL OR "team_id" IS NOT NULL);
