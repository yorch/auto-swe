-- Two relational links run visibility joins through, where the facts used to
-- live only in JSON or in a workflow-id naming convention.
--
-- `channel_id`: a channel-assistant run (mention, ambient digest, reactive
-- interjection) has no work request, so no relational path led from the run to
-- anyone but a platform ADMIN — its channel lived only in
-- `spec_snapshot.channel`. The link makes the channel's owning team reachable.
--
-- `connection_id`: an epic child's work request is the epic's, which spans every
-- repository in the epic. Visibility through the work request would hand a
-- member of any one of those teams every child. The run's own repository is
-- what decides who may see, cancel or approve it.
ALTER TABLE "workflow_runs" ADD COLUMN "channel_id" UUID,
ADD COLUMN "connection_id" UUID;

CREATE INDEX "workflow_runs_channel_id_idx" ON "workflow_runs"("channel_id");

CREATE INDEX "workflow_runs_connection_id_idx" ON "workflow_runs"("connection_id");

ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "slack_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill channel runs from the snapshot. Joined against `slack_channels` so a
-- snapshot naming a channel that has since been deleted stays null rather than
-- failing the foreign key, and compared as text so a malformed id matches
-- nothing instead of aborting the cast.
UPDATE "workflow_runs" AS r
SET "channel_id" = c."id"
FROM "slack_channels" AS c
WHERE r."channel_id" IS NULL
  AND r."spec_snapshot" -> 'channel' ->> 'channelId' = c."id"::text;

-- Backfill epic children. A child's workflow id is `<epic workflow id>-<repo
-- uuid>` and its run links the epic's work request, which is cross-repo with no
-- template. Both conditions, plus an exact match of the trailing uuid against a
-- real connection, so an unrelated run whose id happens to end in a uuid is
-- left alone.
UPDATE "workflow_runs" AS r
SET "connection_id" = c."id"
FROM "run_inputs" AS wr, "connections" AS c
WHERE r."connection_id" IS NULL
  AND r."work_request_id" = wr."id"
  AND wr."is_cross_repo" = true
  AND wr."template_id" IS NULL
  AND r."workflow_id" = 'epic-' || wr."external_ticket_id" || '-' || c."id"::text;
