-- CreateEnum
CREATE TYPE "JoinRequestNotificationEvent" AS ENUM ('CREATED', 'APPROVED', 'REJECTED', 'PENDING_ORG');

-- CreateEnum
CREATE TYPE "JoinRequestNotificationChannel" AS ENUM ('SLACK', 'EMAIL');

-- CreateEnum
CREATE TYPE "JoinRequestNotificationAudience" AS ENUM ('TEAM_CHANNEL', 'TEAM_REVIEWERS', 'REQUESTER', 'ORG_ADMINS');

-- CreateEnum
CREATE TYPE "JoinRequestNotificationStatus" AS ENUM ('PENDING', 'DELIVERED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "join_request_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "event" "JoinRequestNotificationEvent" NOT NULL,
    "channel" "JoinRequestNotificationChannel" NOT NULL,
    "audience" "JoinRequestNotificationAudience" NOT NULL,
    "status" "JoinRequestNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "reached" JSONB NOT NULL DEFAULT '[]',
    "delivered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "join_request_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "join_request_notifications_status_next_attempt_at_idx" ON "join_request_notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "join_request_notifications_status_updated_at_idx" ON "join_request_notifications"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "join_request_notifications_request_id_event_audience_key" ON "join_request_notifications"("request_id", "event", "audience");

-- AddForeignKey
ALTER TABLE "join_request_notifications" ADD CONSTRAINT "join_request_notifications_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "team_join_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

