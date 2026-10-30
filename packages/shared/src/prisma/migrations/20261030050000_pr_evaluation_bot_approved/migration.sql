-- Whether the approver App's approval stood on the evaluated head when the evaluation ended. A
-- repository switched off, or deactivated, is found by this flag and its bot approval withdrawn.
-- Off for every existing row.
ALTER TABLE "pr_evaluations" ADD COLUMN "bot_approved" BOOLEAN NOT NULL DEFAULT false;
