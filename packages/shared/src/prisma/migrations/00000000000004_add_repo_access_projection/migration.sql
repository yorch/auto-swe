-- What the source-control host last said about one user's access to one
-- repository. A cache of GitHub's answers, not a grant table: the only writer
-- is the permission sync, and editing a row by hand grants access GitHub does
-- not back until the next sweep takes it away again.
--
-- ON DELETE CASCADE on both sides: a row is meaningless once either the user or
-- the repository is gone, and keeping it would let a recycled id inherit a
-- stale answer.
CREATE TYPE "RepoPermissionLevel" AS ENUM ('NONE', 'READ', 'WRITE', 'ADMIN');

CREATE TABLE "repo_access" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "permission" "RepoPermissionLevel" NOT NULL,
    -- Not touched by a failed lookup: the row keeps saying what was last
    -- actually known and grows stale, rather than recording an outage as a
    -- denial.
    "checked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repo_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "repo_access_user_id_connection_id_key" ON "repo_access"("user_id", "connection_id");

CREATE INDEX "repo_access_connection_id_idx" ON "repo_access"("connection_id");

-- Supports the staleness sweep, which walks oldest-first.
CREATE INDEX "repo_access_checked_at_idx" ON "repo_access"("checked_at");

ALTER TABLE "repo_access" ADD CONSTRAINT "repo_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "repo_access" ADD CONSTRAINT "repo_access_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
