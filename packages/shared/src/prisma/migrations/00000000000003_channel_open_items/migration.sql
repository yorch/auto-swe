-- ----------------------------------------------------------------------------
-- Channel open-item tracking (Gap C): follow-up on forgotten threads/tasks.
-- Adds the ChannelOpenItem table and its status enum.
-- ----------------------------------------------------------------------------

CREATE TYPE "channel_open_item_status" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

CREATE TABLE "channel_open_items" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "channel_id"    UUID         NOT NULL,
    "description"   TEXT         NOT NULL,
    "owner_user_id" TEXT,
    "status"        "channel_open_item_status" NOT NULL DEFAULT 'OPEN',
    "source_ts"     TEXT,
    "last_nudged_at" TIMESTAMPTZ,
    "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updated_at"    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "channel_open_items_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "channel_open_items"
    ADD CONSTRAINT "channel_open_items_channel_id_fkey"
    FOREIGN KEY ("channel_id")
    REFERENCES "slack_channels"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "channel_open_items_channel_id_status_idx"
    ON "channel_open_items"("channel_id", "status");
