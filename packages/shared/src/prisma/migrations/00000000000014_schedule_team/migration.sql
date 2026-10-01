-- ── Scheduled work requests: the team that owns the schedule ──────────────
-- The repository's owning team, or a team it is shared with. Null (every
-- existing row, and a schedule whose team is deleted) means the repository's
-- owning team.
ALTER TABLE "scheduled_work_requests" ADD COLUMN "team_id" UUID;

CREATE INDEX "scheduled_work_requests_team_id_idx" ON "scheduled_work_requests"("team_id");

ALTER TABLE "scheduled_work_requests" ADD CONSTRAINT "scheduled_work_requests_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
