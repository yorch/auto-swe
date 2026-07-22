-- ----------------------------------------------------------------------------
-- Tier-2 operator knobs (GLOBAL): move previously-hardcoded worker constants
-- (per-tier token budgets, agent iteration caps, workspace container sizing,
-- lesson-retrieval relevance, eval health/judge thresholds) into
-- workflow_defaults so they're tunable via /admin/workflow without a redeploy.
-- Plain additive columns (Prisma-expressible), so this is an ordinary
-- incremental migration.
-- ----------------------------------------------------------------------------
ALTER TABLE "workflow_defaults"
  ADD COLUMN "budget_standard_input_tokens"  INTEGER NOT NULL DEFAULT 2000000,
  ADD COLUMN "budget_standard_output_tokens" INTEGER NOT NULL DEFAULT 500000,
  ADD COLUMN "budget_large_input_tokens"     INTEGER NOT NULL DEFAULT 8000000,
  ADD COLUMN "budget_large_output_tokens"    INTEGER NOT NULL DEFAULT 2000000,
  ADD COLUMN "budget_epic_input_tokens"      INTEGER NOT NULL DEFAULT 20000000,
  ADD COLUMN "budget_epic_output_tokens"     INTEGER NOT NULL DEFAULT 5000000,
  ADD COLUMN "max_tdd_iterations"            INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "max_eval_iterations"           INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "workspace_memory"              TEXT    NOT NULL DEFAULT '4g',
  ADD COLUMN "workspace_cpus"                DOUBLE PRECISION NOT NULL DEFAULT 2,
  ADD COLUMN "workspace_pids_limit"          INTEGER NOT NULL DEFAULT 512,
  ADD COLUMN "workspace_image"               TEXT    NOT NULL DEFAULT 'node:24-alpine',
  ADD COLUMN "lesson_retrieval_limit"        INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "lesson_retrieval_threshold"    DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  ADD COLUMN "eval_health_max_flake_rate"    DOUBLE PRECISION NOT NULL DEFAULT 0.1,
  ADD COLUMN "eval_health_max_stale_rate"    DOUBLE PRECISION NOT NULL DEFAULT 0.1,
  ADD COLUMN "eval_health_min_kappa"         DOUBLE PRECISION NOT NULL DEFAULT 0.4,
  ADD COLUMN "eval_judge_threshold"          DOUBLE PRECISION NOT NULL DEFAULT 0.5;
