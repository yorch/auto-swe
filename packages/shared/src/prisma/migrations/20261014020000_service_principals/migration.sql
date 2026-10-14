-- Service principals: team-owned machine identities that start and follow runs without acting as
-- a person. Their tokens live in `api_tokens` beside personal access tokens, so a token now has
-- exactly one owner of two kinds (a user, or a service principal), and carries scopes that only a
-- service token reads. Additive: every issued personal access token keeps its owner, hash and
-- expiry, and its `scopes` default to the empty list, which a user token ignores.

-- CreateTable
CREATE TABLE "service_principals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by_id" UUID,
    "disabled_at" TIMESTAMPTZ,
    "max_runs_per_day" INTEGER NOT NULL DEFAULT 50,
    "max_in_flight" INTEGER NOT NULL DEFAULT 5,
    "connection_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "template_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_principals_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "api_tokens" ALTER COLUMN "user_id" DROP NOT NULL,
ADD COLUMN     "service_principal_id" UUID,
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "run_inputs" ADD COLUMN     "requested_by_service_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "service_principals_team_id_name_key" ON "service_principals"("team_id", "name");

-- CreateIndex
CREATE INDEX "service_principals_created_by_id_idx" ON "service_principals"("created_by_id");

-- CreateIndex
CREATE INDEX "api_tokens_service_principal_id_idx" ON "api_tokens"("service_principal_id");

-- CreateIndex
CREATE INDEX "run_inputs_requested_by_service_id_created_at_idx" ON "run_inputs"("requested_by_service_id", "created_at");

-- AddForeignKey
ALTER TABLE "service_principals" ADD CONSTRAINT "service_principals_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_principals" ADD CONSTRAINT "service_principals_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_service_principal_id_fkey" FOREIGN KEY ("service_principal_id") REFERENCES "service_principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_inputs" ADD CONSTRAINT "run_inputs_requested_by_service_id_fkey" FOREIGN KEY ("requested_by_service_id") REFERENCES "service_principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── DDL the Prisma DSL cannot express ──

-- Array columns are NOT NULL: an absent list would read as "nothing allowed" in one place and as
-- "unknown" in another. The empty list is the one spelling of "nothing".
ALTER TABLE "service_principals"
  ALTER COLUMN "connection_ids" SET NOT NULL,
  ALTER COLUMN "template_ids" SET NOT NULL;
UPDATE "api_tokens" SET "scopes" = ARRAY[]::TEXT[] WHERE "scopes" IS NULL;
ALTER TABLE "api_tokens" ALTER COLUMN "scopes" SET NOT NULL;

-- A token belongs to exactly one owner. Neither is a token nobody can revoke from their own
-- settings and nothing cascades away; both would be a token that authenticates as a person and a
-- machine at once.
ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_exactly_one_owner"
  CHECK (num_nonnulls("user_id", "service_principal_id") = 1);

-- A principal's own limits are positive: zero would be a disabled principal by another name, and
-- `disabled_at` is the one switch for that.
ALTER TABLE "service_principals"
  ADD CONSTRAINT "service_principals_limits_positive"
  CHECK ("max_runs_per_day" >= 1 AND "max_in_flight" >= 1);
