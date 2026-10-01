-- ── Scheduled work requests: whose identity every fire launches as ─────────
-- The user who last defined what the schedule does. Null (every existing row,
-- and a schedule whose author is deleted) means no launcher: the platform
-- credential only.
ALTER TABLE "scheduled_work_requests" ADD COLUMN "acts_as_user_id" UUID;

CREATE INDEX "scheduled_work_requests_acts_as_user_id_idx" ON "scheduled_work_requests"("acts_as_user_id");

ALTER TABLE "scheduled_work_requests" ADD CONSTRAINT "scheduled_work_requests_acts_as_user_id_fkey" FOREIGN KEY ("acts_as_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Repositories shared with further teams ────────────────────────────────
-- Members of a shared team may see and launch on the repository; the owning
-- team keeps management. ON DELETE CASCADE on both sides: a share means
-- nothing once either the repository or the team is gone.
CREATE TABLE "connection_team_shares" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_team_shares_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "connection_team_shares_team_id_idx" ON "connection_team_shares"("team_id");

CREATE INDEX "connection_team_shares_created_by_id_idx" ON "connection_team_shares"("created_by_id");

CREATE UNIQUE INDEX "connection_team_shares_connection_id_team_id_key" ON "connection_team_shares"("connection_id", "team_id");

ALTER TABLE "connection_team_shares" ADD CONSTRAINT "connection_team_shares_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "connection_team_shares" ADD CONSTRAINT "connection_team_shares_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "connection_team_shares" ADD CONSTRAINT "connection_team_shares_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Repair URL overrides the Import-from-GitHub flow wrote ────────────────
-- `github_url` / `github_api_url` are BASE URLs: the clone is
-- `<github_url>/<org>/<repo>.git` and the API is `<github_api_url>/repos/<org>/<repo>`.
-- The import dialog stored the repository's own `html_url` and `url` there,
-- so every clone and API call for an imported repository landed on a path
-- that does not exist. Strip the repository-level suffix back to the base.
-- `right()` rather than LIKE: owner and repository names may contain `_`,
-- which LIKE reads as a wildcard.
UPDATE "connections"
SET "github_url" = rtrim("github_url", '/')
WHERE "type" = 'git_repo' AND "github_url" IS NOT NULL;

UPDATE "connections"
SET "github_url" = left("github_url", length("github_url") - 4)
WHERE "type" = 'git_repo' AND lower(right("github_url", 4)) = '.git';

UPDATE "connections"
SET "github_url" = left(
    "github_url",
    length("github_url") - length('/' || "organization_name" || '/' || "repo_name")
)
WHERE "type" = 'git_repo'
  AND "github_url" IS NOT NULL
  AND "organization_name" IS NOT NULL
  AND "repo_name" IS NOT NULL
  AND lower(right("github_url", length('/' || "organization_name" || '/' || "repo_name")))
      = lower('/' || "organization_name" || '/' || "repo_name");

UPDATE "connections"
SET "github_api_url" = rtrim("github_api_url", '/')
WHERE "type" = 'git_repo' AND "github_api_url" IS NOT NULL;

UPDATE "connections"
SET "github_api_url" = left(
    "github_api_url",
    length("github_api_url") - length('/repos/' || "organization_name" || '/' || "repo_name")
)
WHERE "type" = 'git_repo'
  AND "github_api_url" IS NOT NULL
  AND "organization_name" IS NOT NULL
  AND "repo_name" IS NOT NULL
  AND lower(right("github_api_url", length('/repos/' || "organization_name" || '/' || "repo_name")))
      = lower('/repos/' || "organization_name" || '/' || "repo_name");

-- Canonical form, which every comparison in the application now uses exactly:
-- the scheme and host lower-cased, and an explicit default port dropped. A
-- legacy `https://GHE.corp` or `https://ghe.corp:443` would otherwise be refused
-- every credential, miss its webhooks, and dodge the duplicate check.
UPDATE "connections"
SET "github_url" =
    lower(substring("github_url" from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+'))
    || COALESCE(substring("github_url" from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+(.*)$'), '')
WHERE "type" = 'git_repo' AND "github_url" ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+';

UPDATE "connections"
SET "github_api_url" =
    lower(substring("github_api_url" from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+'))
    || COALESCE(substring("github_api_url" from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+(.*)$'), '')
WHERE "type" = 'git_repo' AND "github_api_url" ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+';

UPDATE "connections"
SET "github_url" = regexp_replace("github_url", '^(https://[^/:?#]+):443(/|$)', '\1\2')
WHERE "type" = 'git_repo' AND "github_url" IS NOT NULL;

UPDATE "connections"
SET "github_api_url" = regexp_replace("github_api_url", '^(https://[^/:?#]+):443(/|$)', '\1\2')
WHERE "type" = 'git_repo' AND "github_api_url" IS NOT NULL;

-- An override equal to the instance's own GitHub host says nothing an unset
-- one does not. Cleared only when the stored GitHub integration names that
-- host — never by assuming github.com: a deployment whose GitHub Enterprise
-- host is configured through the environment has no row here, and clearing a
-- genuine github.com override on it would repoint that repository at the
-- Enterprise server. The application treats an unset override and one equal to
-- the instance host as the same repository either way.
UPDATE "connections" AS c
SET "github_url" = NULL
FROM "github_config" AS g
WHERE g."id" = 'default'
  AND g."base_url" IS NOT NULL
  AND c."type" = 'git_repo'
  AND lower(c."github_url") = lower(rtrim(g."base_url", '/'));

UPDATE "connections" AS c
SET "github_api_url" = NULL
FROM "github_config" AS g
WHERE g."id" = 'default'
  AND g."api_url" IS NOT NULL
  AND c."type" = 'git_repo'
  AND lower(c."github_api_url") = lower(rtrim(g."api_url", '/'));

-- ── Repository identity includes its host ─────────────────────────────────
-- `acme/api` on github.com and `acme/api` on a GitHub Enterprise server are
-- different repositories. The host is the web base override, normalised by the
-- application to an origin, with NULL meaning the instance's own host. Partial
-- and expression-based, so Prisma cannot express it; it lives here, like the
-- index it replaces.
DROP INDEX IF EXISTS "connections_git_repo_org_repo_uidx";

CREATE UNIQUE INDEX "connections_git_repo_host_org_repo_uidx"
    ON "connections" (COALESCE("github_url", ''), "organization_name", "repo_name")
    WHERE "type" = 'git_repo';
