-- Repository identity compares owner and name case-insensitively.
--
-- A git_repo connection is identified by (host, owner, name). GitHub treats
-- owner and name case-insensitively, so `Acme/API` and `acme/api` on the same
-- host are one repository; the previous index compared them exactly and let both
-- be onboarded. This replaces it with one on lower(owner), lower(name).
--
-- Partial and expression-based, so Prisma cannot express it; it lives here, like
-- the index it replaces.
--
-- The gateway runs `prisma migrate deploy` at boot, so this migration must never
-- fail on data it cannot fix. Two outcomes:
--
--   * No case-only duplicates: the old index is dropped and the new one created.
--   * Case-only duplicates exist: the old (case-sensitive) index is kept, a
--     WARNING is raised, and nothing else changes. `prisma migrate deploy` does
--     not surface that WARNING, so the gateway checks at startup for the missing
--     index and logs the duplicate groups itself (`lib/repoIdentityIndexCheck.ts`).
--     The application's pre-check is case-insensitive regardless, so it still
--     refuses new case-variant onboardings; only the database-level guard
--     against two concurrent requests stays case-sensitive. Merge or delete the
--     duplicates, then create the new index by hand with the same CREATE UNIQUE
--     INDEX statement as below (and drop the old one).
--
-- Rows with a NULL owner or name cannot be duplicates of each other and are
-- left out of the scan.
DO $$
DECLARE
    dups text;
BEGIN
    SELECT string_agg(
               format('(host=%L, owner=%L, name=%L: %s rows)',
                      CASE WHEN d.host = '' THEN '<instance>' ELSE d.host END,
                      d.owner, d.repo, d.n),
               '; ' ORDER BY d.host, d.owner, d.repo)
      INTO dups
      FROM (
          SELECT COALESCE("github_url", '') AS host,
                 lower("organization_name") AS owner,
                 lower("repo_name") AS repo,
                 count(*) AS n
            FROM "connections"
           WHERE "type" = 'git_repo'
             AND "organization_name" IS NOT NULL
             AND "repo_name" IS NOT NULL
           GROUP BY COALESCE("github_url", ''), lower("organization_name"), lower("repo_name")
          HAVING count(*) > 1
      ) d;

    IF dups IS NOT NULL THEN
        RAISE WARNING 'connections_git_repo_host_org_repo_ci_uidx not created: case-only duplicate repositories exist: %. Keeping case-sensitive connections_git_repo_host_org_repo_uidx; the application still refuses new case-variant onboardings. Merge or delete the duplicates, then create the index manually.', dups;
    ELSE
        DROP INDEX IF EXISTS "connections_git_repo_host_org_repo_uidx";

        CREATE UNIQUE INDEX "connections_git_repo_host_org_repo_ci_uidx"
            ON "connections" (COALESCE("github_url", ''), lower("organization_name"), lower("repo_name"))
            WHERE "type" = 'git_repo';
    END IF;
END
$$;
