-- AlterTable
ALTER TABLE "pr_review_drafts" ADD COLUMN     "side" TEXT NOT NULL DEFAULT 'RIGHT',
ADD COLUMN     "start_line" INTEGER;

-- Hand-written: a draft is on one side of the diff, and a range starts before it ends.
ALTER TABLE "pr_review_drafts" ADD CONSTRAINT "pr_review_drafts_side_check" CHECK ("side" IN ('LEFT', 'RIGHT'));
ALTER TABLE "pr_review_drafts" ADD CONSTRAINT "pr_review_drafts_start_line_check" CHECK ("start_line" IS NULL OR "start_line" < "line");
