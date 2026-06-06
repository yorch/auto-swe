-- Add GitHub App authentication fields to github_config singleton table.
-- All fields nullable so existing PAT-only deployments continue unaffected.

ALTER TABLE "github_config" ADD COLUMN "app_id" TEXT;
ALTER TABLE "github_config" ADD COLUMN "app_client_id" TEXT;
ALTER TABLE "github_config" ADD COLUMN "app_client_secret_ciphertext" BYTEA;
ALTER TABLE "github_config" ADD COLUMN "app_client_secret_nonce" BYTEA;
ALTER TABLE "github_config" ADD COLUMN "app_client_secret_auth_tag" BYTEA;
ALTER TABLE "github_config" ADD COLUMN "app_client_secret_key_version" INTEGER;
ALTER TABLE "github_config" ADD COLUMN "app_client_secret_last_four" TEXT;
ALTER TABLE "github_config" ADD COLUMN "app_private_key_ciphertext" BYTEA;
ALTER TABLE "github_config" ADD COLUMN "app_private_key_nonce" BYTEA;
ALTER TABLE "github_config" ADD COLUMN "app_private_key_auth_tag" BYTEA;
ALTER TABLE "github_config" ADD COLUMN "app_private_key_key_version" INTEGER;
ALTER TABLE "github_config" ADD COLUMN "app_private_key_last_four" TEXT;
ALTER TABLE "github_config" ADD COLUMN "app_installation_id" TEXT;
ALTER TABLE "github_config" ADD COLUMN "auth_mode" TEXT;
