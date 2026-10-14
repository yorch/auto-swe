-- `personal_access_tokens` becomes `api_tokens`: the table is about to hold tokens that belong to
-- something other than a person, so its name should not say who owns them. Renamed in place, never
-- dropped and recreated, so every issued `ats_` token keeps working and keeps its hash, expiry and
-- revocation. Prisma derives the key, index and foreign-key names from the table name, so each is
-- renamed with it or the drift check reads them as unexpected.

ALTER TABLE "personal_access_tokens" RENAME TO "api_tokens";

ALTER TABLE "api_tokens"
  RENAME CONSTRAINT "personal_access_tokens_pkey" TO "api_tokens_pkey";
ALTER TABLE "api_tokens"
  RENAME CONSTRAINT "personal_access_tokens_user_id_fkey" TO "api_tokens_user_id_fkey";

ALTER INDEX "personal_access_tokens_token_hash_key" RENAME TO "api_tokens_token_hash_key";
ALTER INDEX "personal_access_tokens_user_id_idx" RENAME TO "api_tokens_user_id_idx";
