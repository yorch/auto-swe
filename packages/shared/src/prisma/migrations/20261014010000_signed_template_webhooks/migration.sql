-- Signed template webhooks: an encrypted signing secret per template, the secret a rotation
-- replaced (accepted until its expiry), and the template's require-signature switch.
ALTER TABLE "workflow_templates"
  ADD COLUMN "webhook_signing_secret_ciphertext" BYTEA,
  ADD COLUMN "webhook_signing_secret_nonce" BYTEA,
  ADD COLUMN "webhook_signing_secret_auth_tag" BYTEA,
  ADD COLUMN "webhook_signing_secret_key_version" INTEGER,
  ADD COLUMN "webhook_signing_secret_last_four" TEXT,
  ADD COLUMN "webhook_previous_signing_secret_ciphertext" BYTEA,
  ADD COLUMN "webhook_previous_signing_secret_nonce" BYTEA,
  ADD COLUMN "webhook_previous_signing_secret_auth_tag" BYTEA,
  ADD COLUMN "webhook_previous_signing_secret_key_version" INTEGER,
  ADD COLUMN "webhook_previous_signing_secret_last_four" TEXT,
  ADD COLUMN "webhook_previous_signing_secret_expires_at" TIMESTAMPTZ,
  ADD COLUMN "webhook_require_signature" BOOLEAN NOT NULL DEFAULT false;

-- A secret is its whole envelope or nothing: a partial one cannot be decrypted, and a previous
-- secret without an expiry would be accepted forever.
ALTER TABLE "workflow_templates"
  ADD CONSTRAINT "workflow_templates_webhook_signing_secret_check"
  CHECK (
    ("webhook_signing_secret_ciphertext" IS NULL) = ("webhook_signing_secret_nonce" IS NULL)
    AND ("webhook_signing_secret_ciphertext" IS NULL) = ("webhook_signing_secret_auth_tag" IS NULL)
    AND ("webhook_signing_secret_ciphertext" IS NULL) = ("webhook_signing_secret_key_version" IS NULL)
  ),
  ADD CONSTRAINT "workflow_templates_webhook_previous_signing_secret_check"
  CHECK (
    ("webhook_previous_signing_secret_ciphertext" IS NULL) = ("webhook_previous_signing_secret_nonce" IS NULL)
    AND ("webhook_previous_signing_secret_ciphertext" IS NULL) = ("webhook_previous_signing_secret_auth_tag" IS NULL)
    AND ("webhook_previous_signing_secret_ciphertext" IS NULL) = ("webhook_previous_signing_secret_key_version" IS NULL)
    AND ("webhook_previous_signing_secret_ciphertext" IS NULL) = ("webhook_previous_signing_secret_expires_at" IS NULL)
  );
