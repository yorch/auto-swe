-- Migration: 20260619000000_issue_tracker_webhook_secret_encrypt
-- Encrypt webhookSecret in issue_tracker_config using same AES-256-GCM
-- envelope as every other secret in the schema.

ALTER TABLE "issue_tracker_config"
  DROP   COLUMN IF EXISTS "webhook_secret",
  ADD    COLUMN "webhook_secret_ciphertext"  BYTEA,
  ADD    COLUMN "webhook_secret_nonce"       BYTEA,
  ADD    COLUMN "webhook_secret_auth_tag"    BYTEA,
  ADD    COLUMN "webhook_secret_key_version" INTEGER,
  ADD    COLUMN "webhook_secret_last_four"   TEXT;
