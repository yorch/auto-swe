-- ── Scheduled work requests: the team that owns the schedule ──────────────
-- The repository's owning team, or a team it is shared with. Every existing row
-- is backfilled to its repository's owning team below. After that a null means
-- the team was deleted (ON DELETE SET NULL): nobody can say whose the schedule
-- was, so it is managed conservatively (ADMIN or the owning team's lead) and is
-- deactivated when the repository moves or a share is removed.
ALTER TABLE "scheduled_work_requests" ADD COLUMN "team_id" UUID;

-- Without this a schedule from before the column would read as "whoever owns the
-- repository", and silently become the new owner's, still running, on a move.
UPDATE "scheduled_work_requests" s
SET "team_id" = c."team_id"
FROM "connections" c
WHERE c."id" = s."repo_id" AND s."team_id" IS NULL;

CREATE INDEX "scheduled_work_requests_team_id_idx" ON "scheduled_work_requests"("team_id");

ALTER TABLE "scheduled_work_requests" ADD CONSTRAINT "scheduled_work_requests_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
