-- The JQL a Jira filter automation's baseline was taken for. A poll whose JQL differs from it
-- takes a new baseline, so a changed query never starts runs for what it already matched, whatever
-- order a change to the query and a poll landed in.

-- AlterTable
ALTER TABLE "automation_poll_states" ADD COLUMN     "baseline_jql" TEXT;
