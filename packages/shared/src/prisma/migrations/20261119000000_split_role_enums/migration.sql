-- Split the shared "Role" enum into PlatformRole / TeamRole and rename OrgRole's values.
--
-- Hand-written (see the prisma-pgvector-hnsw skill): Prisma's generated diff cannot cast a populated
-- enum column to a new enum type, and the hand-written CHECKs and partial indexes on
-- config_permissions read as drift. One transaction: it applies completely or not at all.
--
--   users.role                      ADMIN -> ADMIN, LEAD -> USER, ENGINEER -> USER   (PlatformRole)
--   team_memberships.role           ENGINEER -> MEMBER, LEAD and ADMIN unchanged     (TeamRole)
--   config_permissions.role         ENGINEER -> MEMBER, others unchanged             (TeamRole)
--   organization_memberships.role   ORG_ADMIN -> ADMIN, ORG_MEMBER -> MEMBER         (OrgRole)

-- Bound the wait for the ACCESS EXCLUSIVE locks the type changes take (users is read on every
-- authenticated request): fail fast and retry rather than queue the whole gateway behind a long
-- transaction. SET LOCAL ends with this transaction.
SET LOCAL lock_timeout = '5s';

-- 1. The defaults name the old type, so they go before the columns change type.
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "team_memberships" ALTER COLUMN "role" DROP DEFAULT;

-- 2. Delete the settings grants that cannot be carried over. Before this change the role floor was
--    checked ahead of any grant and a role grant matched the PLATFORM role, so:
--      * every role-grantee row matched a role meaning that no longer exists, and
--      * a user grant held by a platform ENGINEER never took effect and would switch on if kept.
--    User grants held by platform LEAD or ADMIN users worked, and are kept.
DO $$
DECLARE
  role_grants integer;
  inert_user_grants integer;
BEGIN
  DELETE FROM "config_permissions" WHERE "role" IS NOT NULL;
  GET DIAGNOSTICS role_grants = ROW_COUNT;

  DELETE FROM "config_permissions" AS cp
   USING "users" AS u
   WHERE cp."user_id" = u."id" AND u."role"::text = 'ENGINEER';
  GET DIAGNOSTICS inert_user_grants = ROW_COUNT;

  RAISE NOTICE 'split_role_enums: deleted % role-grantee settings grants and % user grants held by platform ENGINEER users; re-issue them as team-role grants',
    role_grants, inert_user_grants;
END $$;

-- 3. A role grant is now a TEAM-scope grant only. The "role_global" and "role_org" partial unique
--    indexes covered scopes that can no longer hold a role grantee; "role_team" stays.
DROP INDEX IF EXISTS "config_permissions_role_global_uidx";
DROP INDEX IF EXISTS "config_permissions_role_org_uidx";
DO $$ BEGIN
  ALTER TABLE "config_permissions" ADD CONSTRAINT "config_permissions_role_scope_check"
    CHECK ("role" IS NULL OR "scope" = 'TEAM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- "config_permissions_grantee_check" (exactly one of user_id / role) is unchanged.

-- 4. New types.
CREATE TYPE "PlatformRole" AS ENUM ('ADMIN', 'USER');
CREATE TYPE "TeamRole" AS ENUM ('ADMIN', 'LEAD', 'MEMBER');

-- 5. Convert the three columns. Altering the type rebuilds the indexes that cover the column
--    ("config_permissions_role_idx", "config_permissions_role_team_uidx") and re-checks the CHECKs.
ALTER TABLE "users" ALTER COLUMN "role" TYPE "PlatformRole" USING (
  CASE "role"::text WHEN 'ADMIN' THEN 'ADMIN' ELSE 'USER' END
)::"PlatformRole";

ALTER TABLE "team_memberships" ALTER COLUMN "role" TYPE "TeamRole" USING (
  CASE "role"::text WHEN 'ENGINEER' THEN 'MEMBER' ELSE "role"::text END
)::"TeamRole";

ALTER TABLE "config_permissions" ALTER COLUMN "role" TYPE "TeamRole" USING (
  CASE "role"::text WHEN 'ENGINEER' THEN 'MEMBER' ELSE "role"::text END
)::"TeamRole";

-- 6. New defaults.
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'USER';
ALTER TABLE "team_memberships" ALTER COLUMN "role" SET DEFAULT 'MEMBER';

-- 7. Organization roles keep their type; only the values are renamed (the default follows the value).
ALTER TYPE "OrgRole" RENAME VALUE 'ORG_ADMIN' TO 'ADMIN';
ALTER TYPE "OrgRole" RENAME VALUE 'ORG_MEMBER' TO 'MEMBER';

-- 8. Nothing uses the old type now.
DROP TYPE "Role";
