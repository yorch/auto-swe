-- The Slack channel sync: who is in each private channel, and when the sync last asked.
--
-- `slack_channel_members` is replaced whole per channel by the sync, so it holds only what Slack's
-- member list said last time. A dashboard user matches through their linked `users.slack_id`.
-- `privacy_checked_at` and `members_synced_at` are null until the sync first answers; a channel
-- whose members were never synced, or not recently, gives its members nothing.

-- AlterTable
ALTER TABLE "slack_channels" ADD COLUMN     "members_synced_at" TIMESTAMPTZ,
ADD COLUMN     "privacy_checked_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "slack_channel_members" (
    "channel_id" UUID NOT NULL,
    "slack_user_id" TEXT NOT NULL,

    CONSTRAINT "slack_channel_members_pkey" PRIMARY KEY ("channel_id","slack_user_id")
);

-- CreateIndex
CREATE INDEX "slack_channel_members_slack_user_id_idx" ON "slack_channel_members"("slack_user_id");

-- AddForeignKey
ALTER TABLE "slack_channel_members" ADD CONSTRAINT "slack_channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "slack_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

