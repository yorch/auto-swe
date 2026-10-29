-- Hand-written: a fourth per-repository mode, `enforce`, for the two CHECK constraints that list the
-- modes. Both are dropped and re-added in one migration, so no row is ever checked against a
-- half-updated list. A NULL pr_evaluation_mode still means "inherit the registry default".
ALTER TABLE "connections" DROP CONSTRAINT "connections_pr_evaluation_mode_check";
ALTER TABLE "connections" ADD CONSTRAINT "connections_pr_evaluation_mode_check"
    CHECK ("pr_evaluation_mode" IN ('off', 'advisory', 'enforce', 'auto'));

ALTER TABLE "pr_evaluations" DROP CONSTRAINT "pr_evaluations_mode_check";
ALTER TABLE "pr_evaluations" ADD CONSTRAINT "pr_evaluations_mode_check"
    CHECK ("mode" IN ('off', 'advisory', 'enforce', 'auto'));
