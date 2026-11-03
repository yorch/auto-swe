-- A repository may choose its own pull request title format and template. Both stay NULL
-- ("inherit the registry value") with no column default, which would shadow the registry.
ALTER TABLE "connections" ADD COLUMN     "pr_title_format" TEXT,
ADD COLUMN     "pr_title_template" TEXT;

-- Hand-written: Prisma cannot express a CHECK. NULL passes, so an unset format still inherits.
ALTER TABLE "connections" ADD CONSTRAINT "connections_pr_title_format_check"
    CHECK ("pr_title_format" IN ('template', 'conventional'));
