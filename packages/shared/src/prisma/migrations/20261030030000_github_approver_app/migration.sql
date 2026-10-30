-- The approver App: a second GitHub App identity that only submits approving reviews. Its own
-- table, never a column on github_config, so the two identities cannot be confused. DB-only.
CREATE TABLE "github_approver_app" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "app_id" TEXT,
    "app_slug" TEXT,
    "private_key_ciphertext" BYTEA,
    "private_key_nonce" BYTEA,
    "private_key_auth_tag" BYTEA,
    "private_key_key_version" INTEGER,
    "private_key_last_four" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" UUID,

    CONSTRAINT "github_approver_app_pkey" PRIMARY KEY ("id")
);


-- The id must always be the literal 'default', as for the other singleton config tables.
ALTER TABLE "github_approver_app"
  ADD CONSTRAINT "github_approver_app_singleton" CHECK ("id" = 'default');
