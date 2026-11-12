ALTER TABLE "connections"
ADD COLUMN "access_verified_at" TIMESTAMPTZ,
ADD COLUMN "onboarding_pr_url" TEXT,
ADD COLUMN "onboarding_pr_number" INTEGER,
ADD COLUMN "onboarding_checklist_dismissed_at" TIMESTAMPTZ;

UPDATE "connections" SET "onboarding_checklist_dismissed_at" = CURRENT_TIMESTAMP;
