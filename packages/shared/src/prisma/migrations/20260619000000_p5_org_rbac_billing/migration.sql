-- P5: Org-level RBAC + monthly billing aggregation
-- Adds OrgRole enum, OrganizationMembership table, OrgMonthlyUsage table,
-- and monthlyBudgetUsdCents column on organizations.

CREATE TYPE "OrgRole" AS ENUM ('ORG_ADMIN', 'ORG_MEMBER');

ALTER TABLE "organizations"
  ADD COLUMN "monthly_budget_usd_cents" INTEGER;

CREATE TABLE "organization_memberships" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID        NOT NULL,
  "org_id"     UUID        NOT NULL,
  "role"       "OrgRole"   NOT NULL DEFAULT 'ORG_MEMBER',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "organization_memberships_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "organization_memberships_user_id_org_id_key"
  ON "organization_memberships"("user_id", "org_id");

CREATE INDEX "organization_memberships_org_id_idx"
  ON "organization_memberships"("org_id");

CREATE TABLE "org_monthly_usage" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "org_id"          UUID         NOT NULL,
  "year_month"      TEXT         NOT NULL,
  "cost_usd_accrued" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "runs_completed"  INTEGER      NOT NULL DEFAULT 0,
  "tokens_input"    BIGINT       NOT NULL DEFAULT 0,
  "tokens_output"   BIGINT       NOT NULL DEFAULT 0,
  "updated_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "org_monthly_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "org_monthly_usage_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "org_monthly_usage_org_id_year_month_key"
  ON "org_monthly_usage"("org_id", "year_month");

CREATE INDEX "org_monthly_usage_org_id_idx"
  ON "org_monthly_usage"("org_id");
