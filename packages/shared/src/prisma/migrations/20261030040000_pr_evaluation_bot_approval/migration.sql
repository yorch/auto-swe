-- Per-repository bot approval: whether the approver App may approve this repository's LOW pull
-- requests. A deliberate switch separate from `auto` mode, off for every existing row. The CHECK is
-- hand-written (Prisma cannot express it): the database itself guarantees the approval only exists
-- in `auto` mode, (a NULL mode, which inherits, is not `auto`), so a mode change away from `auto` must write false in the same update.
ALTER TABLE "connections" ADD COLUMN "pr_evaluation_bot_approval" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "connections"
  ADD CONSTRAINT "connections_bot_approval_requires_auto_check"
  CHECK ("pr_evaluation_bot_approval" = false OR COALESCE("pr_evaluation_mode" = 'auto', false));
