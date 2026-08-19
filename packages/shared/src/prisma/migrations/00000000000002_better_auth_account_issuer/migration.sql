-- ----------------------------------------------------------------------------
-- Better-auth 1.7 rekeys an external identity by (issuer, account_id) instead
-- of (provider_id, account_id). `issuer` is a required column with no default,
-- so an in-place `ALTER TABLE … ADD COLUMN … NOT NULL` would fail on any
-- deployment that already has accounts. Add it nullable, backfill, then
-- tighten — the sequence better-auth's own upgrade guide prescribes.
--
-- Issuer values are not free-form: better-auth derives them in
-- `@better-auth/core/db` and matches on them exactly at sign-in, so a wrong
-- value here silently orphans every linked account.
--
--   credential accounts  → createLocalAccountIssuer('credential')
--                        = 'local:credential'
--   OAuth accounts       → createOAuthAccountIssuer(<providerId>)
--                        = 'local:oauth:' || encodeURIComponent(<providerId>)
--
-- Only the built-in `github` and `google` social providers are configured
-- (see `packages/gateway/src/lib/betterAuth.ts`); neither declares an
-- `accountIssuer` of its own, so both take the synthetic OAuth form. Their IDs
-- contain no characters `encodeURIComponent` would escape, which is why the
-- backfill can concatenate `provider_id` directly.
-- ----------------------------------------------------------------------------

ALTER TABLE "accounts" ADD COLUMN "issuer" TEXT;

UPDATE "accounts"
   SET "issuer" = 'local:credential'
 WHERE "provider_id" = 'credential';

UPDATE "accounts"
   SET "issuer" = 'local:oauth:' || "provider_id"
 WHERE "issuer" IS NULL;

-- The old key guaranteed (provider_id, account_id) uniqueness and the backfill
-- is an injective function of provider_id, so (issuer, account_id) inherits
-- that uniqueness. Assert it rather than trusting it: a deployment that wrote
-- account rows outside better-auth could still collide, and failing here is far
-- cheaper than a partially-migrated auth table.
DO $$
DECLARE
  duplicates BIGINT;
BEGIN
  SELECT COUNT(*) INTO duplicates
    FROM (
      SELECT 1 FROM "accounts"
       GROUP BY "issuer", "account_id"
      HAVING COUNT(*) > 1
    ) AS collisions;

  IF duplicates > 0 THEN
    RAISE EXCEPTION
      'better-auth 1.7 backfill: % (issuer, account_id) collision(s) in "accounts" — resolve them before migrating',
      duplicates;
  END IF;
END
$$;

ALTER TABLE "accounts" ALTER COLUMN "issuer" SET NOT NULL;

DROP INDEX "accounts_provider_id_account_id_key";

CREATE UNIQUE INDEX "accounts_issuer_account_id_key" ON "accounts"("issuer", "account_id");
