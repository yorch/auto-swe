-- AlterTable
ALTER TABLE "pr_evaluations" ADD COLUMN     "changes_requested_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "comments_elsewhere" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "comments_on_flagged" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "comments_on_skimmed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "first_human_review_at" TIMESTAMPTZ;
