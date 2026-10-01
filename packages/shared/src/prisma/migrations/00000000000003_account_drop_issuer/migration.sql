-- ── Better Auth 1.7.3+ no longer uses accounts.issuer ────────────────────────
-- 1.7.0 through 1.7.2 keyed an account by (issuer, accountId); 1.7.3 went back
-- to (providerId, accountId), as in 1.6, and treats a required `issuer` column
-- as one it never writes — so every insert into accounts, including the seeded
-- admin's credential row, fails once it is present.
-- https://www.better-auth.com/docs/guides/1-7-upgrade-guide
--
-- The guide's order matters: the unique index goes before the column.
--
-- (provider_id, account_id) was this table's unique key before 1.7.0 and is
-- what Better Auth looks accounts up by, so it is restored rather than left
-- to chance. Creating it fails if two rows share the pair, which would be two
-- sign-ins resolving to one provider identity — report that instead of
-- surfacing an index error.
DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(format('%s / %s (%s rows)', provider_id, account_id, n), E'\n  - ')
    INTO dupes
  FROM (
    SELECT provider_id, account_id, count(*) AS n
    FROM "accounts"
    GROUP BY provider_id, account_id
    HAVING count(*) > 1
  ) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION E'accounts has duplicate (provider_id, account_id) pairs, so the unique key Better Auth looks accounts up by cannot be created. Merge or delete the duplicates, then mark this migration rolled back (Prisma blocks further deploys after a failed one) with `yarn workspace @auto-swe/shared prisma migrate resolve --rolled-back 00000000000003_account_drop_issuer` and deploy again:\n  - %', dupes;
  END IF;
END
$$;

DROP INDEX "accounts_issuer_account_id_key";

CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

ALTER TABLE "accounts" DROP COLUMN "issuer";
