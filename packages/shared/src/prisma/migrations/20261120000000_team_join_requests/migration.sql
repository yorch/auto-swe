-- Team join requests, and the self-service creator of a team.
--
-- The generated part is `prisma migrate diff --from-schema <schema before> --to-schema
-- schema.prisma --script`, read for DROP statements (there are none). The partial unique index at
-- the end is hand-written: the Prisma DSL cannot express a WHERE clause.

-- CreateEnum
CREATE TYPE "JoinRequestStatus" AS ENUM ('PENDING_TEAM', 'PENDING_ORG', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "teams" ADD COLUMN     "created_by_id" UUID;

-- CreateTable
CREATE TABLE "team_join_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'PENDING_TEAM',
    "requires_org_approval" BOOLEAN NOT NULL DEFAULT false,
    "granted_role" "TeamRole",
    "team_decided_by_id" UUID,
    "team_decided_at" TIMESTAMPTZ,
    "team_decision_note" TEXT,
    "org_decided_by_id" UUID,
    "org_decided_at" TIMESTAMPTZ,
    "org_decision_note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_join_requests_team_id_status_idx" ON "team_join_requests"("team_id", "status");

-- CreateIndex
CREATE INDEX "team_join_requests_user_id_created_at_idx" ON "team_join_requests"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "teams_created_by_id_idx" ON "teams"("created_by_id");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_join_requests" ADD CONSTRAINT "team_join_requests_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_join_requests" ADD CONSTRAINT "team_join_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_join_requests" ADD CONSTRAINT "team_join_requests_team_decided_by_id_fkey" FOREIGN KEY ("team_decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_join_requests" ADD CONSTRAINT "team_join_requests_org_decided_by_id_fkey" FOREIGN KEY ("org_decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One open request per user and team. A final request (APPROVED, REJECTED, WITHDRAWN) does not
-- count, so a rejected user may ask again once the cooldown the API applies has passed.
CREATE UNIQUE INDEX "team_join_requests_open_user_team_key"
  ON "team_join_requests" ("user_id", "team_id")
  WHERE "status" IN ('PENDING_TEAM', 'PENDING_ORG');
